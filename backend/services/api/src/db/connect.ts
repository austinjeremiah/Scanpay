import mongoose from 'mongoose';
import { log } from '../log.js';

let isUp = false;

export async function connectDb(uri: string): Promise<void> {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  isUp = true;
  log.info({ uri: uri.replace(/\/\/.*@/, '//***@') }, 'mongodb connected');
  mongoose.connection.on('disconnected', () => { isUp = false; log.warn('mongodb disconnected'); });
  mongoose.connection.on('reconnected', () => { isUp = true; log.info('mongodb reconnected'); });
}

export function dbUp(): boolean {
  return isUp && mongoose.connection.readyState === 1;
}
