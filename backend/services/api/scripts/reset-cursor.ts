/**
 * Resets the chain follower cursors so the follower rescans from startBlock.
 * Run this after deploying the PaymentSettled upsert fix so all historical
 * payments get indexed into the Atlas MongoDB.
 *
 * Usage: tsx --env-file=../../../.env scripts/reset-cursor.ts
 */
import mongoose from 'mongoose';
import { Cursor } from '../src/db/models.js';

const MONGODB_URI = process.env.MONGODB_URI!;
await mongoose.connect(MONGODB_URI);
console.log('connected to mongodb');

// Reset cursors to the deployment's startBlock so the follower rescans all contract history
// without wasting time on pre-deployment blocks.
const START_TESTNET = 70485353;
const START_MAINNET = 112857175;
const r10143 = await Cursor.findOneAndUpdate({ chainId: 10143 }, { $set: { lastBlock: START_TESTNET } });
const r143   = await Cursor.findOneAndUpdate({ chainId: 143   }, { $set: { lastBlock: START_MAINNET } });
console.log(`reset testnet cursor: ${r10143 ? r10143.lastBlock + ' → ' + START_TESTNET : 'not found (ok)'}`);
console.log(`reset mainnet cursor: ${r143   ? r143.lastBlock   + ' → ' + START_MAINNET : 'not found (ok)'}`);

await mongoose.disconnect();
console.log('done');
