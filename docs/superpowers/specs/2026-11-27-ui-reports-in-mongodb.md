# UI reports in MongoDB, CLI on files, CLI cleanup

Date: 2026-11-27. Status: approved by the developer in chat.

## Goal

The web UI's reports are shared by the team, so the UI server stores them in
MongoDB. The CLI keeps file storage under `data/` and gains a cleanup command.
The 20 existing reports are not imported.

## Storage split

- `src/report-store.ts` defines `ReportStore`: `saveReport`, `updateReport`,
  `saveCategories`, `loadReport`, `loadRuns`, `loadCategories`, `listSummaries`.
- `FileStore` wraps today's `src/storage.ts` functions with no change in
  behaviour. The CLI uses the storage functions as before.
- `MongoStore` (`src/db/mongo-store.ts`) is used by the UI server only.
- `runReport` takes an optional `store`. Without one it saves with `FileStore`,
  so the CLI is unchanged. The server passes its `MongoStore`.
- `buildServer` requires `store` in its options. The server entry point connects
  to MongoDB and passes a `MongoStore`. Tests may pass a `FileStore`.

## MongoDB (same pattern as course-suite and guvi-unified)

- One connection module, `src/db/mongo.ts`: one shared `MongoClient` from the
  env var `MONGODB_URI`, pinged at start. The server stops if the ping fails.
  No other file creates a client. The CLI never imports it.
- A thin wrapper (`find`, `findOne`, `insert`, `insertMany`, `update`,
  `atomicUpsert`, `count`). `update` always wraps the data in `$set`. The wrapper
  has no delete, drop, replace or `$unset`. Every call names its database and
  collection.
- Database `PSI-API` (`getDBName()`), override `PSI_MONGO_DB` for tests.
- Collections:
  - `reports`: one document per report: the report as JSON text, beside the
    plain list fields `host`, `generatedAt` and `summary`.
  - `runs`: one document per run: `reportId`, `index`, `run` (JSON text).
  - `categories`: one document per report: `reportId`, `categories` (JSON text).
  - Why JSON text: a report reads back exactly as the file store returns it
    (BSON would turn a missing field into null), and Lighthouse keys with dots
    or `$` cannot break a write. Only the list fields can be queried in MongoDB.
- Reads with an id that cannot exist return null (a 404), as the file store does.
- `updateReport` (reanalyze) writes with `$set`; runs are never rewritten.
- Driver pinned to `mongodb@6.9.0`: the dev server is MongoDB 3.6.8, and driver
  6.10 dropped 3.6.
- Indexes only through `npm run db:indexes` (`scripts/db-indexes.ts`), run on
  purpose. The server never creates an index.
  - `reports`: `{reportId: 1}` unique (it also serves the newest-first list;
    nothing queries by host, so no host index)
  - `runs`: `{reportId: 1, index: 1}` unique
  - `categories`: `{reportId: 1}` unique

## Old SEO routes

`POST /seo`, `GET /seo` and `GET /seo/:seoId` are removed from the server. The
CLI's `--seoId` and `--seoList` keep reading `data/<host>/seo/` files.

## CLI cleanup

- `psi --cleanup` deletes every report folder whose report-ID timestamp is more
  than 3 days old: the whole folder (`report.json`, `runs.json`,
  `categories.json`).
- It keeps host folders, `seo/` folders, `optimization-log.md` and any folder
  whose name is not a report ID.
- `--dry-run` lists what it would delete. `--json` prints the result as JSON.
- One failed folder is reported and the rest continue.
- A measurement whose report saved but whose categories did not is kept, with
  a warning.
- Files only. Nothing deletes from MongoDB.

## Done means

- UI: run a measurement on localhost:3939, see it in the sidebar, open its
  Overview, Findings, Requests and SEO and more tabs, reanalyze it. All data
  comes from MongoDB.
- CLI: a measurement lands in `data/`, not in MongoDB. `--cleanup` works.
- Tests pass, including MongoStore tests against the dev MongoDB.
