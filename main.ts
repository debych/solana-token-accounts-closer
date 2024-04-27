import {
    AccountInfo,
    Connection,
    Keypair,
    ParsedAccountData,
    PublicKey,
    sendAndConfirmTransaction,
    TransactionExpiredBlockheightExceededError,
    Transaction,
} from "@solana/web3.js";
import * as base58 from "bs58";
import {createCloseAccountInstruction} from "@solana/spl-token";
import config from "./config/config";

const cliProgress = require("cli-progress");
const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const connectionGet = new Connection(config.GET_RPC);
const connectionRPC = new Connection(config.SEND_RPC);
const wallet = Keypair.fromSecretKey(
    Buffer.from(
        base58.decode(
            config.PRIVATE_KEY
        )
    )
);

async function sendTransactionWithRetry(txn: Transaction, connectionRPC: Connection, wallet: Keypair) {
    let success = false;
    while (!success) {
        try {
            await sendAndConfirmTransaction(connectionRPC, txn, [wallet]);
            success = true;
        } catch (error: any) {
            if (error instanceof TransactionExpiredBlockheightExceededError) {
                throw new TransactionExpiredBlockheightExceededError("-");
            } else {
                console.error('Error sending transaction:', error);
                await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay
            }
        }
    }
}

async function closeChunkOfAccounts(
    chunk: Array<{
        pubkey: PublicKey;
        account: AccountInfo<ParsedAccountData>;
    }>,
    wallet: Keypair
) {
    let success = false;
    while (!success) {
        const txn = new Transaction();

        const recentBlockhash = (await connectionGet.getLatestBlockhash()).blockhash;
        txn.feePayer = wallet.publicKey;
        txn.recentBlockhash = recentBlockhash;
        chunk.forEach((account) => {
            txn.add(createCloseAccountInstruction(account.pubkey, wallet.publicKey, wallet.publicKey));
        });

        try {
            await sendTransactionWithRetry(txn, connectionRPC, wallet);
            success = true;
        } catch (error: any) {
            if (error instanceof TransactionExpiredBlockheightExceededError) {
                console.log("Transaction expired. Retrying...");
                await closeChunkOfAccounts(chunk, wallet);
            } else {
                console.error('Error sending transaction:', error);
            }
        }
    }
}


async function main() {
    // Split an array into chunks of length `chunkSize`
    const chunks = <T>(array: T[], chunkSize = 10): T[][] => {
        let res: T[][] = [];
        for (let currentChunk = 0; currentChunk < array.length; currentChunk += chunkSize) {
            res.push(array.slice(currentChunk, currentChunk + chunkSize));
        }
        return res;
    };

    // Get all token accounts of `wallet`
    const tokenAccounts = await connectionGet.getParsedTokenAccountsByOwner(wallet.publicKey, {programId: TOKEN_PROGRAM_ID});

    // You can only close accounts that have a 0 token balance. Be sure to filter those out!
    const filteredAccounts = tokenAccounts.value.filter(account => account.account.data.parsed.info.tokenAmount.uiAmount === 0);

    console.log(`There are ${filteredAccounts.length} accounts to close`)

    const accountsChunks = chunks(filteredAccounts);

    console.log(`Sending ${accountsChunks.length} transactions`);

    bar.start(accountsChunks.length, 0);

    const PromiseArray = accountsChunks.map(
        (chunk) => closeChunkOfAccounts(chunk, wallet).then(() => {
            bar.increment();
        })
    );
    await Promise.all(PromiseArray);

    bar.stop();
}

main().then(() => {
    console.log("Done");
}).catch((err) => {
    console.error("Error:", err);
})