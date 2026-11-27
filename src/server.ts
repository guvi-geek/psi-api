import { config as loadEnv } from 'dotenv';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import type {
  AggregatedReport,
  FilterGroup,
  Job,
  JobProgress,
  MetricKey,
  SortField,
  SortOrder,
} from './types.js';
import { METRIC_KEYS, STATS, STRATEGIES } from './types.js';
import { filterInsights } from './insights.js';
import { diagnose } from './diagnose.js';
import { imagesOf } from './images.js';
import { InsufficientRunsError, MAX_RUNS, runReport } from './runner.js';
import { UrlValidationError } from './psiClient.js';
import type { ReportStore } from './report-store.js';
import { closeMongo, connectMongo } from './db/mongo.js';
import { checkIndexes, MongoStore } from './db/mongo-store.js';
import { diffReanalyzed, reanalyze, type ReanalyzeDelta } from './reanalyze.js';
import { loadTargets } from './targets.js';
import { assessMeasurement } from './validity.js';

loadEnv();

const FILTER_GROUPS = ['opportunity', 'diagnostic', 'passed', 'informative'] as const;
const SORT_FIELDS = ['savingsMs', 'savingsBytes', 'score', 'firstPartyShare'] as const;
const ORDERS = ['asc', 'desc'] as const;
const PARTIES = ['any', 'first', 'third'] as const;

const CACHE_TTL_MS = 10 * 60 * 1000;

/* ---------------------------------- schemas --------------------------------- */

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()),
  );

const numericParam = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `expected a number, got "${value}"` });
      return z.NEVER;
    }
    return parsed;
  });

/** Splits "a,b" and tolerates repeated params (`?group=a&group=b`). */
const csv = (allowed?: readonly string[]) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((value) =>
      (Array.isArray(value) ? value.join(',') : value)
        .split(',')
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean),
    )
    .refine(
      (parts) => !allowed || parts.every((part) => allowed.includes(part)),
      `allowed values: ${allowed?.join(', ')}`,
    );

const reportParams = z.object({
  url: z.string().min(1),
  strategy: z.enum(STRATEGIES).default('mobile'),
  runs: z.coerce.number().int().min(1).max(MAX_RUNS).default(10),
  stat: z.enum(STATS).default('median'),
  force: boolish.default(false),
  async: boolish.default(false),
  /** false = do not write the report to data/ (the CLI's --no-save). */
  save: boolish.default(true),
});

const filterParams = z.object({
  group: csv(FILTER_GROUPS).optional(),
  minSavingsMs: numericParam.optional(),
  minSavingsBytes: numericParam.optional(),
  maxScore: numericParam.optional(),
  metric: csv(METRIC_KEYS).optional(),
  search: z.string().optional(),
  id: csv().optional(),
  hasItems: boolish.optional(),
  party: z.enum(PARTIES).default('any'),
  minFirstPartyRatio: numericParam.pipe(z.number().min(0).max(1)).optional(),
  sortBy: z.enum(SORT_FIELDS).default('savingsMs'),
  order: z.enum(ORDERS).default('desc'),
  limit: numericParam.pipe(z.number().int().min(0)).optional(),
  includeFlaky: boolish.default(true),
});

export type ReportParams = z.infer<typeof reportParams>;
export type FilterParams = z.infer<typeof filterParams>;

/* ----------------------------------- state ---------------------------------- */

interface CacheEntry {
  report: AggregatedReport;
  expiresAt: number;
}

const reportCache = new Map<string, CacheEntry>();
const jobs = new Map<string, Job>();
const jobsByRequest = new Map<string, Job>();
let jobCounter = 0;

function cacheKey(params: ReportParams): string {
  return [params.url, params.strategy, params.runs, params.stat, params.save ? 'save' : 'nosave'].join('|');
}

function readCache(key: string): AggregatedReport | undefined {
  const hit = reportCache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    reportCache.delete(key);
    return undefined;
  }
  return hit.report;
}

function writeCache(key: string, report: AggregatedReport): void {
  reportCache.set(key, { report, expiresAt: Date.now() + CACHE_TTL_MS });
}

/* ---------------------------------- helpers --------------------------------- */

function toErrorPayload(error: unknown): { code: string; message: string } {
  if (error instanceof UrlValidationError) return { code: error.code, message: error.message };
  if (error instanceof InsufficientRunsError)
    return { code: 'INSUFFICIENT_RUNS', message: error.message };
  if (error instanceof z.ZodError) {
    const first = error.issues[0];
    const field = first?.path.join('.');
    return {
      code: 'INVALID_PARAMS',
      message: field ? `${field}: ${first?.message}` : (first?.message ?? 'invalid parameters'),
    };
  }
  if (error instanceof Error) return { code: error.name || 'ERROR', message: error.message };
  return { code: 'ERROR', message: String(error) };
}

function statusForError(error: unknown): number {
  if (error instanceof UrlValidationError || error instanceof z.ZodError) return 400;
  if (error instanceof InsufficientRunsError) return 502;
  return 500;
}

function compact(query: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries((query ?? {}) as Record<string, unknown>)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Test seam: lets a test drive real runs through a fake PSI. Production passes nothing. */
export interface ServerOptions {
  /** Where reports are kept. The server entry point passes MongoDB; tests may pass a FileStore. */
  store: ReportStore;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Built web UI to serve at `/`. Defaults to web/out (the Next.js export); skipped when it has not been built. */
  webDir?: string;
}

/** web/out, from either src/server.ts or dist/server.js: both sit one level under the repo root. */
const DEFAULT_WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'out');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

/**
 * Serves the built UI: `/` is index.html, `/_next/*` is the Next.js export's
 * files (hashed under /_next/static, so cached for good). The UI routes with
 * the URL hash, so no API path is ever shadowed.
 */
function registerWebUi(app: FastifyInstance, webDir: string): void {
  const indexFile = path.join(webDir, 'index.html');
  if (!existsSync(indexFile)) return;
  const assetsDir = path.join(webDir, '_next');

  app.get('/', async (_req, reply) =>
    reply
      .header('cache-control', 'no-cache')
      .type(MIME['.html']!)
      .send(await readFile(indexFile)),
  );

  app.get<{ Params: { '*': string } }>('/_next/*', async (req, reply) => {
    const file = path.resolve(assetsDir, req.params['*']);
    const type = MIME[path.extname(file).toLowerCase()];
    if (!file.startsWith(assetsDir + path.sep) || !type) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'no such asset' } });
    }
    try {
      const body = await readFile(file);
      const hashed = file.startsWith(path.join(assetsDir, 'static') + path.sep);
      return reply
        .header('cache-control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache')
        .type(type)
        .send(body);
    } catch {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'no such asset' } });
    }
  });
}

async function produceReport(
  params: ReportParams,
  log: FastifyBaseLogger,
  serverOptions: ServerOptions,
  onProgress?: (entry: JobProgress) => void,
): Promise<{ report: AggregatedReport; saved: boolean; warnings: string[] }> {
  const result = await runReport({
    url: params.url,
    strategy: params.strategy,
    runs: params.runs,
    stat: params.stat,
    save: params.save,
    store: serverOptions.store,
    fetchImpl: serverOptions.fetchImpl,
    sleepImpl: serverOptions.sleepImpl,
    onRetry: ({ reason, attempt, maxAttempts, delayMs }) => {
      log.warn({ reason, attempt, maxAttempts, delayMs }, 'psi retry');
    },
    onRunFinished: ({ run, ok, score, error, cached }) => {
      if (ok) log.info({ run, score }, 'psi run complete');
      else log.warn({ run, error }, 'psi run failed');
      onProgress?.({ run, ok, score, error, cached });
    },
  });
  for (const warning of result.warnings) log.warn(warning);
  return { report: result.report, saved: result.saved, warnings: result.warnings };
}

/**
 * Saving was asked for but the store did not take the report. Such a report is
 * not cached, so the next request measures again and tries to save it.
 */
function lostSave(params: { save: boolean }, produced: { saved: boolean }): boolean {
  return params.save && !produced.saved;
}

/** A synchronous answer is the report itself, so a report that could not be stored says so in a header. */
function markUnsaved(reply: FastifyReply, params: { save: boolean }, produced: { saved: boolean; warnings: string[] }) {
  if (lostSave(params, produced)) {
    const why = produced.warnings.find((warning) => warning.startsWith('Measured, but')) ?? 'the report could not be saved';
    reply.header('x-psi-not-saved', why.replace(/[\r\n]+/g, ' '));
  }
}

function startJob(params: ReportParams, log: FastifyBaseLogger, serverOptions: ServerOptions): Job {
  jobCounter += 1;
  const id = `job_${Date.now().toString(36)}_${jobCounter}`;
  const job: Job = {
    id,
    status: 'queued',
    createdAt: new Date().toISOString(),
    request: { url: params.url, strategy: params.strategy, runs: params.runs, stat: params.stat },
    progress: [],
    save: params.save,
  };
  jobs.set(id, job);
  jobsByRequest.set(cacheKey(params), job);

  const key = cacheKey(params);
  void (async () => {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    try {
      const produced = await produceReport(params, log, serverOptions, (entry) => job.progress?.push(entry));
      job.status = 'done';
      job.result = produced.report;
      job.saved = produced.saved;
      if (produced.warnings.length > 0) job.warnings = produced.warnings;
      if (!lostSave(params, produced)) writeCache(key, produced.report);
    } catch (error) {
      job.status = 'failed';
      job.error = toErrorPayload(error);
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  })();

  return job;
}

function insightsPayload(report: AggregatedReport, filters: FilterParams) {
  const typed = {
    group: filters.group as FilterGroup[] | undefined,
    minSavingsMs: filters.minSavingsMs,
    minSavingsBytes: filters.minSavingsBytes,
    maxScore: filters.maxScore,
    metric: filters.metric as MetricKey[] | undefined,
    search: filters.search,
    id: filters.id as string[] | undefined,
    hasItems: filters.hasItems,
    party: filters.party,
    minFirstPartyRatio: filters.minFirstPartyRatio,
    sortBy: filters.sortBy as SortField,
    order: filters.order as SortOrder,
    limit: filters.limit,
    includeFlaky: filters.includeFlaky,
  };
  const insights = filterInsights(report.insights, typed);
  return {
    reportId: report.reportId,
    url: report.url,
    strategy: report.strategy,
    stat: report.stat,
    runsRequested: report.runsRequested,
    runsSucceeded: report.runsSucceeded,
    headline: report.headline,
    targets: report.targets,
    score: report.score,
    distributions: report.distributions,
    lcp: report.lcp,
    totalInsights: report.insights.length,
    matched: insights.length,
    filters: typed,
    insights,
  };
}

/** The ranked work queue, same ranking the CLI's `--diagnose` prints. */
function diagnosisPayload(report: AggregatedReport, filters: FilterParams) {
  return diagnose(report, {
    filters: {
      group: filters.group as FilterGroup[] | undefined,
      party: filters.party,
      minFirstPartyRatio: filters.minFirstPartyRatio,
      sortBy: filters.sortBy as SortField,
      limit: filters.limit,
      includeFlaky: filters.includeFlaky,
    },
  });
}

/* ---------------------------------- server ---------------------------------- */

const insightsBody = z.object({
  url: z.string().min(1),
  strategy: z.enum(STRATEGIES).default('mobile'),
  runs: z.coerce.number().int().min(1).max(MAX_RUNS).default(10),
  stat: z.enum(STATS).default('median'),
  force: boolish.default(false),
  filters: filterParams
    .partial({ sortBy: true, order: true, includeFlaky: true, party: true })
    .optional(),
});

/** A page of the report list. The sidebar asks for 50 at a time. */
const reportsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** The last reportId of the previous page. */
  before: z.string().min(1).max(100).optional(),
  /** Only pages whose address contains this. */
  q: z.string().max(200).optional(),
});

const reanalyzeBody = z.object({
  /** Omit to rebuild every stored report, like the CLI's bare --reanalyze. */
  reportId: z.string().min(1).optional(),
  save: boolish.default(true),
});

interface ReanalyzeRow {
  reportId: string;
  delta: ReanalyzeDelta | null;
  error?: string;
  saved: boolean;
}

/** Same rebuild the CLI's --reanalyze runs: stored runs in, report out, runs.json untouched. */
async function reanalyzeStored(store: ReportStore, reportIds: string[], save: boolean): Promise<ReanalyzeRow[]> {
  const targets = loadTargets();
  const rows: ReanalyzeRow[] = [];
  for (const reportId of reportIds) {
    try {
      const before = await store.loadReport(reportId);
      const runs = await store.loadRuns(reportId);
      if (!runs) {
        rows.push({ reportId, delta: null, error: 'no stored runs', saved: false });
        continue;
      }
      if (!before) {
        rows.push({ reportId, delta: null, error: 'no stored report', saved: false });
        continue;
      }
      const after = reanalyze(runs, {
        reportId,
        stat: before.stat,
        runsRequested: before.runsRequested,
        targets,
      });
      const delta = diffReanalyzed(before, after);
      if (save) await store.updateReport(after);
      rows.push({ reportId, delta, saved: save });
    } catch (error) {
      rows.push({
        reportId,
        delta: null,
        error: error instanceof Error ? error.message : String(error),
        saved: false,
      });
    }
  }
  return rows;
}

const notFound = (reportId: string) => ({
  error: { code: 'NOT_FOUND', message: `no stored report "${reportId}"` },
});

export function buildServer(options: ServerOptions): FastifyInstance {
  const { store } = options;
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  app.setErrorHandler((error, _req, reply) => {
    const status = statusForError(error);
    if (status >= 500) app.log.error({ err: error }, 'request failed');
    return reply.status(status).send({ error: toErrorPayload(error) });
  });

  app.get('/health', async () => ({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    apiKeyConfigured: Boolean(process.env.PSI_API_KEY),
    cacheEntries: reportCache.size,
    activeJobs: [...jobs.values()].filter((job) => job.status === 'running').length,
  }));

  const reportHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = req.method === 'GET' ? compact(req.query) : { ...((req.body ?? {}) as object) };
    const params = reportParams.parse(raw);
    const key = cacheKey(params);

    if (!params.async) {
      const cached = params.force ? undefined : readCache(key);
      if (cached) return reply.send({ ...cached, cached: true });
    } else {
      const existing = jobsByRequest.get(key);
      if (existing && (existing.status === 'queued' || existing.status === 'running')) {
        return reply.status(202).send({ jobId: existing.id, status: existing.status });
      }
    }

    if (params.async) {
      const job = startJob(params, req.log, options);
      return reply.status(202).send({ jobId: job.id, status: job.status });
    }

    const produced = await produceReport(params, req.log, options);
    if (!lostSave(params, produced)) writeCache(key, produced.report);
    markUnsaved(reply, params, produced);
    return reply.send(produced.report);
  };

  app.get('/report', reportHandler);
  app.post('/report', reportHandler);

  const findReport = async (reportId: string): Promise<AggregatedReport | null> =>
    store.loadReport(reportId);

  app.get<{ Params: { reportId: string } }>('/report/:reportId', async (req, reply) => {
    const report = await findReport(req.params.reportId);
    if (!report) {
      return reply
        .status(404)
        .send({ error: { code: 'NOT_FOUND', message: `no stored report "${req.params.reportId}"` } });
    }
    return reply.send(report);
  });

  // The report's other categories (accessibility, best practices, SEO, agentic browsing),
  // read in the same PSI calls. Free. `null` for a report measured before runs read them.
  app.get<{ Params: { reportId: string } }>('/report/:reportId/categories', async (req, reply) => {
    const report = await findReport(req.params.reportId);
    if (!report) {
      return reply
        .status(404)
        .send({ error: { code: 'NOT_FOUND', message: `no stored report "${req.params.reportId}"` } });
    }
    return reply.send({ reportId: report.reportId, categories: await store.loadCategories(report.reportId) });
  });

  app.get<{ Params: { reportId: string }; Querystring: Record<string, unknown> }>(
    '/report/:reportId/insights',
    async (req, reply) => {
      const report = await findReport(req.params.reportId);
      if (!report) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: `no stored report "${req.params.reportId}"` } });
      }
      return reply.send(insightsPayload(report, filterParams.parse(compact(req.query))));
    },
  );

  // Ranked work queue. Same ranking the CLI's --diagnose prints, so a machine
  // consumer does not have to reimplement the prioritisation.
  app.get<{ Params: { reportId: string }; Querystring: Record<string, unknown> }>(
    '/report/:reportId/diagnosis',
    async (req, reply) => {
      const report = await findReport(req.params.reportId);
      if (!report) {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: `no stored report "${req.params.reportId}"` } });
      }
      const runs = await store.loadRuns(req.params.reportId);
      return reply.send({
        reportId: report.reportId,
        url: report.url,
        strategy: report.strategy,
        headline: report.headline,
        targets: report.targets,
        lcp: report.lcp,
        distributions: report.distributions,
        images: imagesOf(report),
        validity: assessMeasurement({ report, runs }),
        ...diagnosisPayload(report, filterParams.parse(compact(req.query))),
      });
    },
  );

  app.post('/insights', async (req, reply) => {
    const body = insightsBody.parse((req.body ?? {}) as object);
    const params: ReportParams = {
      url: body.url,
      strategy: body.strategy,
      runs: body.runs,
      stat: body.stat,
      force: body.force,
      async: false,
      save: true,
    };
    const key = cacheKey(params);

    let report = body.force ? undefined : readCache(key);
    if (!report) {
      const produced = await produceReport(params, req.log, options);
      report = produced.report;
      if (!lostSave(params, produced)) writeCache(key, report);
      markUnsaved(reply, params, produced);
    }
    return reply.send(insightsPayload(report, filterParams.parse(body.filters ?? {})));
  });

  // The CLI's --list, a page at a time, with the fields a report picker needs. Free.
  // `next` is the cursor for the following page: pass it as `before`; null when this is the last.
  app.get('/reports', async (req) => {
    const query = reportsQuery.parse(compact(req.query));
    const page = await store.listSummaries({ limit: query.limit + 1, before: query.before, q: query.q?.trim() || undefined });
    const reports = page.slice(0, query.limit);
    return { reports, next: page.length > query.limit ? reports[reports.length - 1]!.reportId : null };
  });

  // The CLI's --reanalyze. Free: rebuilds from the stored runs, never calls PSI.
  app.post('/reanalyze', async (req, reply) => {
    // It rewrites stored reports, so it takes only a JSON body. A JSON request needs a CORS
    // preflight, which this server never grants, so another site open in the
    // browser cannot send one. A body-less or text/plain POST can, so it is refused.
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      return reply.status(415).send({
        error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'send a JSON body, e.g. {"save": false}' },
      });
    }
    const body = reanalyzeBody.parse((req.body ?? {}) as object);
    if (body.reportId && !(await store.loadReport(body.reportId))) {
      return reply.status(404).send(notFound(body.reportId));
    }
    const ids = body.reportId
      ? [body.reportId]
      : (await store.listSummaries()).map((summary) => summary.reportId);
    return reply.send({ reanalyzed: await reanalyzeStored(store, ids, body.save) });
  });

  // The budgets every verdict is graded against. Read-only.
  app.get('/targets', async () => loadTargets());

  registerWebUi(app, options.webDir ?? DEFAULT_WEB_DIR);

  app.get<{ Params: { jobId: string } }>('/jobs/:jobId', async (req, reply) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      return reply
        .status(404)
        .send({ error: { code: 'NOT_FOUND', message: `no job "${req.params.jobId}"` } });
    }
    return reply.send(job);
  });

  return app;
}

/* ----------------------------------- main ----------------------------------- */

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const port = Number(process.env.PORT ?? 3939);
  const host = process.env.HOST ?? '127.0.0.1';

  // The UI's reports live in MongoDB, so the server does not start without it.
  connectMongo()
    .catch((error) => {
      console.error(`psi-api: cannot reach MongoDB: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    })
    // Without its unique indexes the list sorts in memory (and fails once large) and ids are not unique.
    // The server never creates them: `npm run db:indexes` does, once per database.
    .then(async () => {
      const missing = await checkIndexes();
      if (missing.length > 0) {
        console.error(`psi-api: MongoDB is missing ${missing.length} index(es): ${missing.join('; ')}. Run npm run db:indexes once, then start again.`);
        process.exit(1);
      }
    })
    .then(() => {
      const app = buildServer({ store: new MongoStore() });

      if (!process.env.PSI_API_KEY) {
        app.log.warn(
          'PSI_API_KEY is not set. PSI will fall back to the shared anonymous quota, which is very low ' +
            'and typically returns HTTP 429. Copy .env.example to .env and add your key.',
        );
      }

      app
        .listen({ port, host })
        .then(() => {
          app.log.info({ host, port }, 'psi-api listening, reports in MongoDB');
          if (existsSync(path.join(DEFAULT_WEB_DIR, 'index.html'))) {
            app.log.info(`UI ready at http://${host}:${port}/`);
          }
        })
        .catch((error) => {
          app.log.error(error);
          process.exit(1);
        });

      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, () => {
          void app
            .close()
            .then(() => closeMongo())
            .then(() => process.exit(0));
        });
      }
    });
}
