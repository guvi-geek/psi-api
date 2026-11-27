/**
 * The one MongoDB connection, as course-suite's backend/header.php and
 * guvi-unified's html/model/header.php open theirs: one shared client, its
 * address from the environment only (MONGODB_URI, as course-suite names it),
 * opened once when the UI server starts. No other file creates a client, and
 * the CLI never imports this file: it keeps its reports as files.
 *
 * The wrapper below plays the part of mongo-orm.php: insert, read and `$set`
 * updates only. GUVI bans destructive database operations, so it has no
 * delete, drop, replace or `$unset`. Every call names its own database and
 * collection, so no query can run against a collection an earlier call chose.
 *
 * The dev server is MongoDB 3.6.8, so the driver is pinned to 6.9 (6.10
 * dropped 3.6). Avoid features newer servers add, such as pipeline updates.
 */
import { MongoClient, type Document, type Filter, type FindOptions, type OptionalUnlessRequiredId } from 'mongodb';

let client: MongoClient | null = null;
let connecting: Promise<MongoClient> | null = null;

/** The database the UI's reports live in. PSI_MONGO_DB overrides it, for tests. */
export function getDBName(): string {
  return process.env.PSI_MONGO_DB || 'PSI-API';
}

/** Connect once and ping, as course-suite's worker does. Throws when the server cannot be reached. */
export async function connectMongo(uri = process.env.MONGODB_URI): Promise<MongoClient> {
  if (client) return client;
  if (connecting) return connecting;
  if (!uri) throw new Error('MONGODB_URI is not set. Add it to .env: the web UI keeps its reports in MongoDB.');
  connecting = (async () => {
    const next = new MongoClient(uri, { maxPoolSize: 50, maxIdleTimeMS: 60_000, serverSelectionTimeoutMS: 10_000 });
    await next.connect();
    try {
      await next.db('admin').command({ ping: 1 });
    } catch (error) {
      await next.close();
      throw error;
    }
    client = next;
    return next;
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

export async function closeMongo(): Promise<void> {
  const open = client;
  client = null;
  await open?.close();
}

function collection<T extends Document>(db: string, name: string) {
  if (!client) throw new Error('MongoDB is not connected: call connectMongo() first.');
  return client.db(db).collection<T>(name);
}

/** A collection's indexes, or none when the collection does not exist yet. */
export async function indexesOf(db: string, name: string): Promise<Array<{ key: Record<string, unknown>; unique?: boolean }>> {
  try {
    return (await collection(db, name).indexes()) as Array<{ key: Record<string, unknown>; unique?: boolean }>;
  } catch {
    return [];
  }
}

export function find<T extends Document>(db: string, name: string, filter: Filter<T> = {}, options: FindOptions = {}) {
  return collection<T>(db, name).find(filter, options).toArray();
}

export function findOne<T extends Document>(db: string, name: string, filter: Filter<T>, options: FindOptions = {}) {
  return collection<T>(db, name).findOne(filter, options);
}

export async function insert<T extends Document>(db: string, name: string, doc: OptionalUnlessRequiredId<T>) {
  return collection<T>(db, name).insertOne(doc);
}

export async function insertMany<T extends Document>(db: string, name: string, docs: OptionalUnlessRequiredId<T>[]) {
  if (docs.length === 0) throw new Error('insertMany needs at least one document');
  return collection<T>(db, name).insertMany(docs, { ordered: true });
}

/** A partial update: the fields given are `$set`, every other field stays. */
export async function update<T extends Document>(
  db: string,
  name: string,
  filter: Filter<T>,
  fields: Partial<T>,
  options: { upsert?: boolean; multi?: boolean } = {},
) {
  if (Object.keys(fields).length === 0) throw new Error('update needs at least one field');
  const target = collection<T>(db, name);
  const change = { $set: fields } as Document;
  return options.multi
    ? target.updateMany(filter, change, { upsert: options.upsert ?? false })
    : target.updateOne(filter, change, { upsert: options.upsert ?? false });
}

/** guvi-unified's atomicUpsert: `data` only when the document is new, `setFields` always. */
export async function atomicUpsert<T extends Document>(
  db: string,
  name: string,
  filter: Filter<T>,
  data: Partial<T>,
  setFields: Partial<T> = {},
) {
  if (Object.keys(filter).length === 0 || Object.keys(data).length === 0) {
    throw new Error('atomicUpsert needs a filter and data');
  }
  const change: Document = { $setOnInsert: data };
  if (Object.keys(setFields).length > 0) change.$set = setFields;
  return collection<T>(db, name).updateOne(filter, change, { upsert: true });
}

export function count<T extends Document>(db: string, name: string, filter: Filter<T> = {}) {
  return collection<T>(db, name).countDocuments(filter);
}
