/**
 * The web UI's reports in MongoDB: one shared history for the team.
 *
 * Each payload (report, run, categories) is stored as the same JSON text the
 * file store writes, so a report reads back exactly as the CLI's would: a
 * missing field stays missing (BSON would turn `undefined` into null) and a
 * non-finite number becomes null exactly as JSON makes it. The fields the code
 * filters and sorts on sit beside the text as plain values.
 *
 * Writes are inserts and `$set` upserts only. Nothing here deletes.
 */
import type { AggregatedReport, NormalizedReport } from '../types.js';
import type { ReportCategories } from '../categories.js';
import { hostKey, summarize, type ListOptions, type ReportStore, type ReportSummary } from '../report-store.js';
import { find, findOne, getDBName, indexesOf, update } from './mongo.js';

export const COLLECTIONS = { reports: 'reports', runs: 'runs', categories: 'categories' } as const;

/**
 * The unique indexes the UI's queries rely on. `npm run db:indexes` creates
 * them; the server only checks they are there (it never creates an index).
 */
export const REQUIRED_INDEXES: Array<{ collection: string; keys: Record<string, 1 | -1> }> = [
  { collection: COLLECTIONS.reports, keys: { reportId: 1 } },
  { collection: COLLECTIONS.runs, keys: { reportId: 1, index: 1 } },
  { collection: COLLECTIONS.categories, keys: { reportId: 1 } },
];

/** Which required indexes a database lacks, given each collection's index list. */
export function missingIndexes(existing: Record<string, Array<{ key: Record<string, unknown>; unique?: boolean }>>): string[] {
  const same = (a: Record<string, unknown>, b: Record<string, unknown>) => JSON.stringify(a) === JSON.stringify(b);
  return REQUIRED_INDEXES.filter(
    (required) => !(existing[required.collection] ?? []).some((index) => index.unique === true && same(index.key, required.keys)),
  ).map((required) => `${required.collection} ${JSON.stringify(required.keys)} (unique)`);
}

/** Read the index lists of the live database and report any required one that is missing. */
export async function checkIndexes(): Promise<string[]> {
  const existing: Record<string, Array<{ key: Record<string, unknown>; unique?: boolean }>> = {};
  for (const { collection } of REQUIRED_INDEXES) existing[collection] = await indexesOf(getDBName(), collection);
  return missingIndexes(existing);
}

/** Escapes text so a search for "a.b" matches a dot, not any character. */
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface ReportDoc {
  reportId: string;
  host: string;
  url: string;
  strategy: string;
  generatedAt: string;
  summary: ReportSummary;
  /** The report as JSON text. */
  report: string;
  savedAt: string;
  updatedAt?: string;
}

interface RunDoc {
  reportId: string;
  index: number;
  /** One run as JSON text. */
  run: string;
}

interface CategoriesDoc {
  reportId: string;
  /** The median run's other categories as JSON text. */
  categories: string;
  savedAt: string;
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

function isSafeId(reportId: string): boolean {
  return typeof reportId === 'string' && SAFE_ID.test(reportId);
}

/** For writes: a report id from our own code that is not safe is a bug. */
function assertReportId(reportId: string): void {
  if (!isSafeId(reportId)) throw new Error(`invalid reportId: ${reportId}`);
}

function reportFields(report: AggregatedReport) {
  const host = hostKey(report.url);
  return {
    host,
    url: report.url,
    strategy: report.strategy,
    generatedAt: report.generatedAt,
    summary: summarize(report, host),
    report: JSON.stringify(report),
  };
}

export class MongoStore implements ReportStore {
  async saveReport(report: AggregatedReport, runs: NormalizedReport[]) {
    assertReportId(report.reportId);
    const db = getDBName();
    // Runs first: the report document is what lists a report, so it only appears once its runs are stored.
    for (const [index, run] of runs.entries()) {
      await update<RunDoc>(
        db,
        COLLECTIONS.runs,
        { reportId: report.reportId, index },
        { reportId: report.reportId, index, run: JSON.stringify(run) },
        { upsert: true },
      );
    }
    await update<ReportDoc>(
      db,
      COLLECTIONS.reports,
      { reportId: report.reportId },
      { reportId: report.reportId, ...reportFields(report), savedAt: new Date().toISOString() },
      { upsert: true },
    );
    return { reportId: report.reportId, location: `mongodb ${db}.${COLLECTIONS.reports}` };
  }

  async updateReport(report: AggregatedReport): Promise<void> {
    assertReportId(report.reportId);
    const result = await update<ReportDoc>(
      getDBName(),
      COLLECTIONS.reports,
      { reportId: report.reportId },
      { ...reportFields(report), updatedAt: new Date().toISOString() },
    );
    if (result.matchedCount === 0) throw new Error(`no stored report "${report.reportId}"`);
  }

  async saveCategories(report: Pick<AggregatedReport, 'reportId' | 'url'>, categories: ReportCategories) {
    assertReportId(report.reportId);
    await update<CategoriesDoc>(
      getDBName(),
      COLLECTIONS.categories,
      { reportId: report.reportId },
      { reportId: report.reportId, categories: JSON.stringify(categories), savedAt: new Date().toISOString() },
      { upsert: true },
    );
  }

  // Reads take ids from URLs: one that cannot exist is simply not stored (a 404, as the file store answers).
  async loadReport(reportId: string): Promise<AggregatedReport | null> {
    if (!isSafeId(reportId)) return null;
    const doc = await findOne<ReportDoc>(getDBName(), COLLECTIONS.reports, { reportId }, { projection: { report: 1 } });
    return doc ? (JSON.parse(doc.report) as AggregatedReport) : null;
  }

  async loadRuns(reportId: string): Promise<NormalizedReport[] | null> {
    if (!isSafeId(reportId)) return null;
    const docs = await find<RunDoc>(getDBName(), COLLECTIONS.runs, { reportId }, { sort: { index: 1 } });
    return docs.length > 0 ? docs.map((doc) => JSON.parse(doc.run) as NormalizedReport) : null;
  }

  async loadCategories(reportId: string): Promise<ReportCategories | null> {
    if (!isSafeId(reportId)) return null;
    const doc = await findOne<CategoriesDoc>(getDBName(), COLLECTIONS.categories, { reportId });
    return doc ? (JSON.parse(doc.categories) as ReportCategories) : null;
  }

  async listSummaries(options: ListOptions = {}): Promise<ReportSummary[]> {
    // Report ids are timestamp-prefixed, so a reverse sort is newest first, as the file store lists them.
    // The sort walks the unique reportId index, so a page reads only that page.
    const filter: Record<string, unknown> = {};
    if (options.before !== undefined) filter.reportId = { $lt: options.before };
    if (options.q) filter.url = { $regex: escapeRegex(options.q), $options: 'i' };
    const docs = await find<ReportDoc>(getDBName(), COLLECTIONS.reports, filter, {
      projection: { summary: 1 },
      sort: { reportId: -1 },
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    });
    return docs.map((doc) => doc.summary);
  }
}
