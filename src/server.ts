import { config as loadEnv } from 'dotenv';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { pathToFileURL } from 'node:url';
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
import { getDataDir, listReports, loadReport, loadRuns, saveReport } from './storage.js';
import { compareReports, defaultCompareMetric } from './compare.js';
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
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

async function produceReport(
  params: ReportParams,
  log: FastifyBaseLogger,
  serverOptions: ServerOptions,
  onProgress?: (entry: JobProgress) => void,
): Promise<AggregatedReport> {
  const result = await runReport({
    url: params.url,
    strategy: params.strategy,
    runs: params.runs,
    stat: params.stat,
    save: params.save,
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
  return result.report;
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
  };
  jobs.set(id, job);
  jobsByRequest.set(cacheKey(params), job);

  const key = cacheKey(params);
  void (async () => {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    try {
      const report = await produceReport(params, log, serverOptions, (entry) => job.progress?.push(entry));
      job.status = 'done';
      job.result = report;
      writeCache(key, report);
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

const compareQuery = z.object({
  before: z.string().min(1),
  after: z.string().min(1),
  // Same list the CLI's --compare --metric accepts.
  metric: z.enum(METRIC_KEYS).optional(),
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
async function reanalyzeStored(reportIds: string[], save: boolean): Promise<ReanalyzeRow[]> {
  const targets = loadTargets();
  const rows: ReanalyzeRow[] = [];
  for (const reportId of reportIds) {
    try {
      const before = await loadReport(reportId);
      const runs = await loadRuns(reportId);
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
      if (save) await saveReport(after, runs, getDataDir());
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

export function buildServer(options: ServerOptions = {}): FastifyInstance {
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

    const report = await produceReport(params, req.log, options);
    writeCache(key, report);
    return reply.send(report);
  };

  app.get('/report', reportHandler);
  app.post('/report', reportHandler);

  const findReport = async (reportId: string): Promise<AggregatedReport | null> =>
    loadReport(reportId);

  app.get<{ Params: { reportId: string } }>('/report/:reportId', async (req, reply) => {
    const report = await findReport(req.params.reportId);
    if (!report) {
      return reply
        .status(404)
        .send({ error: { code: 'NOT_FOUND', message: `no stored report "${req.params.reportId}"` } });
    }
    return reply.send(report);
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
      const runs = await loadRuns(req.params.reportId);
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
      report = await produceReport(params, req.log, options);
      writeCache(key, report);
    }
    return reply.send(insightsPayload(report, filterParams.parse(body.filters ?? {})));
  });

  // The CLI's --list, with the fields a report picker needs. Free: reads data/ only.
  app.get('/reports', async () => {
    const reports = [];
    for (const ref of await listReports()) {
      const report = await loadReport(ref.reportId);
      if (!report) continue;
      const gaps = report.targets?.gaps ?? [];
      reports.push({
        reportId: report.reportId,
        host: ref.host,
        url: report.url,
        strategy: report.strategy,
        stat: report.stat,
        generatedAt: report.generatedAt,
        runsRequested: report.runsRequested,
        runsSucceeded: report.runsSucceeded,
        score: report.headline.score,
        lcp: report.headline.metrics.lcp ?? null,
        meetsTarget: report.targets?.meetsTarget ?? null,
        targetsFailing: gaps.filter((gap) => !gap.meets).length,
        targetsTotal: gaps.length,
      });
    }
    return { reports };
  });

  // The CLI's --compare <before> <after> --metric m. Same verdict, same code path.
  app.get('/compare', async (req, reply) => {
    const query = compareQuery.parse(compact(req.query));
    const before = await loadReport(query.before);
    if (!before) return reply.status(404).send(notFound(query.before));
    const after = await loadReport(query.after);
    if (!after) return reply.status(404).send(notFound(query.after));
    const metric = query.metric ?? defaultCompareMetric(before);
    return reply.send({
      beforeId: query.before,
      afterId: query.after,
      ...compareReports(before, after, metric),
    });
  });

  // The CLI's --reanalyze. Free: rebuilds from runs.json, never calls PSI.
  app.post('/reanalyze', async (req, reply) => {
    const body = reanalyzeBody.parse((req.body ?? {}) as object);
    if (body.reportId && !(await loadReport(body.reportId))) {
      return reply.status(404).send(notFound(body.reportId));
    }
    const ids = body.reportId
      ? [body.reportId]
      : (await listReports()).map((ref) => ref.reportId);
    return reply.send({ reanalyzed: await reanalyzeStored(ids, body.save) });
  });

  // The budgets every verdict is graded against. Read-only.
  app.get('/targets', async () => loadTargets());

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
  const app = buildServer();

  if (!process.env.PSI_API_KEY) {
    app.log.warn(
      'PSI_API_KEY is not set. PSI will fall back to the shared anonymous quota, which is very low ' +
        'and typically returns HTTP 429. Copy .env.example to .env and add your key.',
    );
  }

  app
    .listen({ port, host })
    .then(() => app.log.info({ host, port }, 'psi-api listening'))
    .catch((error) => {
      app.log.error(error);
      process.exit(1);
    });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void app.close().then(() => process.exit(0));
    });
  }
}
