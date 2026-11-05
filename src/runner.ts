import type {
  AggregatedReport,
  NormalizedReport,
  RunFailure,
  Stat,
  Strategy,
} from './types.js';
import { aggregateReports, MIN_SUCCESS_RATIO } from './aggregate.js';
import { normalizeReport } from './insights.js';
import { PsiError, runPsiCall, validateTargetUrl, type RetryInfo } from './psiClient.js';
import { isPageNotFound, isUnreachableMessage } from './validity.js';
import { applyTargets, loadTargets, type Targets } from './targets.js';
import { makeReportId, saveReport } from './storage.js';

export const MAX_RUNS = 40;
export const DEFAULT_RUNS = 10;
export const DEFAULT_CONCURRENCY = 10;
/**
 * How many times one slot may be requested before a repeated analysis timestamp
 * is given up on. The first fresh timestamp is accepted; later copies are not
 * a second sample, so they are discarded and the slot is tried again.
 */
export const CACHE_ATTEMPTS_PER_RUN = 3;

export interface RunnerOptions {
  url: string;
  strategy?: Strategy;
  runs?: number;
  stat?: Stat;
  categories?: string[];
  apiKey?: string;
  concurrency?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  randomImpl?: () => number;
  /** Set false to skip writing to disk (used by tests). */
  save?: boolean;
  dataDir?: string;
  targets?: Targets;
  onRetry?: (info: RetryInfo) => void;
  onRunFinished?: (info: {
    run: number;
    ok: boolean;
    score?: number;
    error?: string;
    /** True when this attempt repeated an analysis timestamp already accepted. It was not kept. */
    cached?: boolean;
  }) => void;
  signal?: AbortSignal;
}

export interface RunnerResult {
  report: AggregatedReport;
  runs: NormalizedReport[];
  warnings: string[];
  dir?: string;
}

export function resolveConcurrency(): number {
  const parsed = Number(process.env.PSI_CONCURRENCY);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_CONCURRENCY;
  return Math.min(Math.floor(parsed), 10);
}

export class InsufficientRunsError extends Error {
  readonly succeeded: number;
  readonly requested: number;

  constructor(succeeded: number, requested: number, failures: RunFailure[]) {
    const detail = failures
      .slice(0, 3)
      .map((failure) => `run ${failure.run}: ${failure.message}`)
      .join('; ');
    super(
      `Only ${succeeded} of ${requested} PSI runs succeeded ` +
        `(need at least ${Math.ceil(requested * MIN_SUCCESS_RATIO)}). ${detail}`,
    );
    this.name = 'InsufficientRunsError';
    this.succeeded = succeeded;
    this.requested = requested;
  }
}

/** Run PSI N times with bounded concurrency, then aggregate, score and persist. */
export async function runReport(options: RunnerOptions): Promise<RunnerResult> {
  const {
    url,
    strategy = 'mobile',
    runs = DEFAULT_RUNS,
    stat = 'median',
    categories = ['performance'],
    apiKey = process.env.PSI_API_KEY,
    concurrency = resolveConcurrency(),
    save = true,
    dataDir,
    targets,
    onRetry,
    onRunFinished,
    signal,
  } = options;

  const runCount = Math.max(1, Math.min(Math.floor(runs) || 1, MAX_RUNS));
  const { url: validatedUrl, warnings } = validateTargetUrl(url);

  const reports: Array<{ runNumber: number; report: NormalizedReport }> = [];
  const failures: RunFailure[] = [];
  // PSI caches per URL. Two responses with the same Lighthouse fetchTime are one
  // measurement, and the second must not be counted as another sample.
  const acceptedStamps = new Set<string>();

  const runOne = async (runNumber: number): Promise<void> => {
    for (let attempt = 1; attempt <= CACHE_ATTEMPTS_PER_RUN; attempt += 1) {
      try {
        const result = await runPsiCall({
          url: validatedUrl,
          strategy,
          categories,
          apiKey,
          fetchImpl: options.fetchImpl,
          sleepImpl: options.sleepImpl,
          randomImpl: options.randomImpl,
          onRetry,
          signal,
        });
        const normalized = normalizeReport(result.raw, validatedUrl, strategy);
        if (acceptedStamps.has(normalized.fetchTime)) {
          if (attempt === CACHE_ATTEMPTS_PER_RUN) {
            const message = 'PSI served a cached report';
            failures.push({ run: runNumber, message });
            onRunFinished?.({ run: runNumber, ok: false, error: message });
            return;
          }
          onRunFinished?.({ run: runNumber, ok: false, cached: true, error: 'cached, retrying' });
          continue;
        }
        acceptedStamps.add(normalized.fetchTime);
        reports.push({ runNumber, report: normalized });
        onRunFinished?.({ run: runNumber, ok: true, score: normalized.score });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ run: runNumber, message });
        onRunFinished?.({ run: runNumber, ok: false, error: message });
        return;
      }
    }
  };

  // The first call goes out alone. A 404 or a host PSI cannot reach would
  // otherwise burn the rest of the batch, and those failures do not change on
  // the next call. When the first call is a real page, the remainder still
  // goes out together at the same concurrency as before.
  await runOne(1);
  const first = reports.find((entry) => entry.runNumber === 1)?.report;
  const firstFailure = failures.find((entry) => entry.run === 1)?.message;
  const stoppedEarly =
    (first ? isPageNotFound(first) : false) ||
    (firstFailure !== undefined && reports.length === 0 && isUnreachableMessage(firstFailure));

  if (!stoppedEarly && runCount > 1) {
    let nextIndex = 1;
    const workerCount = Math.max(1, Math.min(concurrency, runCount - 1));
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= runCount) return;
        await runOne(index + 1);
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  // Deterministic ordering regardless of which worker finished first.
  reports.sort((a, b) => a.runNumber - b.runNumber);
  failures.sort((a, b) => a.run - b.run);
  const ordered = reports.map((entry) => entry.report);

  if (reports.length === 0) {
    throw new InsufficientRunsError(0, runCount, failures);
  }
  // A 404 page is still a report — the caller has to see that it measured the
  // error page. Every other shortfall keeps the 60% rule.
  if (!stoppedEarly && reports.length < Math.ceil(runCount * MIN_SUCCESS_RATIO)) {
    throw new InsufficientRunsError(reports.length, runCount, failures);
  }

  const reportId = makeReportId(validatedUrl, strategy);
  let aggregated = aggregateReports(ordered, {
    stat,
    reportId,
    runsRequested: runCount,
    errors: failures,
  });
  aggregated = applyTargets(aggregated, targets ?? loadTargets());

  const runWarnings = [...warnings];
  if (stoppedEarly) {
    const why = first ? 'the page returned 404 Not Found' : (firstFailure ?? 'the host could not be fetched');
    runWarnings.push(`Stopped after the first run: ${why}. The remaining PSI calls were not sent.`);
  }
  let dir: string | undefined;
  if (save) {
    const saved = await saveReport(aggregated, ordered, dataDir);
    dir = saved.dir;
  }

  const result: RunnerResult = { report: aggregated, runs: ordered, warnings: runWarnings };
  if (dir) result.dir = dir;
  return result;
}

export function isPsiError(error: unknown): error is PsiError {
  return error instanceof PsiError;
}
