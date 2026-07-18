import { Db, MongoClient } from "mongodb";

// Cache the client across hot reloads in dev and across route invocations in
// prod — a new MongoClient per request exhausts Atlas connection limits fast.
const globalForMongo = globalThis as unknown as { _mongoClient?: Promise<MongoClient> };

function getClient(): Promise<MongoClient> {
  if (!globalForMongo._mongoClient) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI is not set");
    globalForMongo._mongoClient = new MongoClient(uri, {
      serverSelectionTimeoutMS: 15000,
    }).connect();
  }
  return globalForMongo._mongoClient;
}

export async function getDb(): Promise<Db> {
  const client = await getClient();
  return client.db("roc");
}
