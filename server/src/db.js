import mongoose from 'mongoose';
import { config } from './config.js';

export async function connectDb() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
  const { host, port, name } = mongoose.connection;
  console.log(`[db] connected to mongodb://${host}:${port}/${name}`);
  return mongoose.connection;
}
