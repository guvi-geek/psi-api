/**
 * The internal tool that creates the UI's MongoDB indexes. Run it on purpose,
 * before the UI server first uses a database: `npm run db:indexes`. The server
 * itself never creates an index (GUVI rule: indexes come from internal tools,
 * never from a request path). Creating an index that exists is a no-op.
 */
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { closeMongo, connectMongo, getDBName } from '../src/db/mongo.js';
import { REQUIRED_INDEXES } from '../src/db/mongo-store.js';

// The same list the server checks for at start.
const INDEXES = REQUIRED_INDEXES.map((index) => ({ ...index, unique: true }));

async function main(): Promise<void> {
  const client: MongoClient = await connectMongo();
  const db = client.db(getDBName());
  for (const index of INDEXES) {
    const name = await db.collection(index.collection).createIndex(index.keys, { unique: index.unique });
    console.log(`${getDBName()}.${index.collection}: ${name}${index.unique ? ' (unique)' : ''}`);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeMongo());
