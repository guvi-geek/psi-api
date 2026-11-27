/**
 * Pure logic behind the run form, the live run grid and the report list.
 * No React here, so tests/web-logic.test.ts can check it directly.
 */

export const MAX_RUNS = 40;
export const DEFAULT_RUNS = 10;

export type Strategy = 'mobile' | 'desktop';
export type Stat = 'median' | 'mean' | 'mode';

export interface RunRequest {
  url: string;
  strategy: Strategy;
  runs: number;
  stat: Stat;
  save: boolean;
}

/**
 * Light checks only: the server does the real validation (private hosts,
 * file: URLs) and its message is shown as-is. A bare host gets https://.
 */
export function normalizeUrl(raw: string): { url?: string; error?: string } {
  const value = raw.trim();
  if (!value) return { error: 'Enter the page address to measure.' };
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { error: `"${value}" is not a page address.` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'Only http and https pages can be measured.' };
  }
  return { url: parsed.href };
}

/**
 * Hosts Google's PSI bots cannot reach. Same list as PRIVATE_HOST_PATTERNS in
 * src/psiClient.ts (tests/web-logic.test.ts checks they agree). The server only
 * warns about these, like the CLI, so the form asks before spending quota.
 */
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
  /^169\.254\.\d{1,3}\.\d{1,3}$/,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /^\[?fe80:/i,
  /\.local$/i,
  /\.internal$/i,
  /\.test$/i,
  /\.localhost$/i,
];

export function isPrivateHost(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
  } catch {
    return false;
  }
}

export function parseRuns(raw: string | number): { runs?: number; error?: string } {
  const runs = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) {
    return { error: `Runs must be a whole number from 1 to ${MAX_RUNS}.` };
  }
  return { runs };
}

/* ------------------------------- run grid ------------------------------- */

export interface JobProgress {
  run: number;
  ok: boolean;
  score?: number;
  error?: string;
  cached?: boolean;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export type Slot =
  | { n: number; state: 'done'; score: number }
  | { n: number; state: 'fail'; error: string }
  | { n: number; state: 'active' }
  | { n: number; state: 'waiting' };

/**
 * Same numbering as the CLI: slots fill in finish order, not by PSI run id.
 * A cached attempt is not a sample and takes no slot. The next open slot
 * spins while the job is still running.
 */
export function slotsFor(progress: JobProgress[], total: number, status: JobStatus): Slot[] {
  const finished = progress.filter((entry) => !entry.cached);
  const slots: Slot[] = [];
  for (let i = 0; i < total; i += 1) {
    const n = i + 1;
    const entry = finished[i];
    if (entry) {
      slots.push(
        entry.ok
          ? { n, state: 'done', score: Math.round(entry.score ?? 0) }
          : { n, state: 'fail', error: entry.error ?? 'run failed' },
      );
    } else if (i === finished.length && (status === 'running' || status === 'queued')) {
      slots.push({ n, state: 'active' });
    } else {
      slots.push({ n, state: 'waiting' });
    }
  }
  return slots;
}

/** Columns of five, like the CLI, so a 40-run grid stays readable. */
export function columnsOf<T>(items: T[], perColumn = 5): T[][] {
  const columns: T[][] = [];
  for (let i = 0; i < items.length; i += perColumn) columns.push(items.slice(i, i + perColumn));
  return columns;
}

/** Lighthouse's own bands: 90+ good, 50–89 needs work, under 50 poor. */
export function scoreBand(score: number): 'good' | 'warn' | 'bad' {
  if (score >= 90) return 'good';
  if (score >= 50) return 'warn';
  return 'bad';
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/* ------------------------------ report list ------------------------------ */

export interface ReportRow {
  reportId: string;
  host: string;
  url: string;
  strategy: Strategy;
  stat: Stat;
  generatedAt: string;
  runsRequested: number;
  runsSucceeded: number;
  score: number;
  lcp: number | null;
  meetsTarget: boolean | null;
  targetsFailing: number;
  targetsTotal: number;
}

export interface HostGroup {
  host: string;
  reports: ReportRow[];
}

/**
 * Groups by host, keeping the server's newest-first order inside each group,
 * and orders the groups by their newest report. `query` matches the URL or id.
 */
export function groupReports(reports: ReportRow[], query = ''): HostGroup[] {
  const needle = query.trim().toLowerCase();
  const groups = new Map<string, ReportRow[]>();
  for (const report of reports) {
    if (needle && !`${report.url} ${report.reportId} ${report.strategy}`.toLowerCase().includes(needle)) continue;
    const list = groups.get(report.host) ?? [];
    list.push(report);
    groups.set(report.host, list);
  }
  return [...groups.entries()].map(([host, list]) => ({ host, reports: list }));
}

/** The report list request: one page of 50, older than `before`, matching `q`. */
export function reportsPath(options: { q?: string; before?: string } = {}): string {
  const params = new URLSearchParams({ limit: '50' });
  if (options.before) params.set('before', options.before);
  if (options.q) params.set('q', options.q);
  return `/reports?${params}`;
}

/** The page path shown under its host heading: "/" for the home page. */
export function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || '/';
  } catch {
    return url;
  }
}

/**
 * When a report was measured, read from its id (2026-11-23T13-13-24Z-mobile).
 * Not `generatedAt`: a re-analysis rewrites that, but keeps the id.
 */
export function measuredAt(reportId: string, fallback: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z/.exec(reportId);
  if (!match) return fallback;
  const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : fallback;
}

/** "Just now", "12 min ago", "3 h ago", then a date. */
export function formatWhen(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const minutes = Math.round((now - then) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The CLI's verdict word: FAIL only when more than half the targets fail, so
 * "2 of 6 failing" is a mostly healthy page that still has work to do.
 */
export function verdictOf(report: Pick<ReportRow, 'targetsFailing' | 'targetsTotal'>): 'PASS' | 'FAIL' {
  return report.targetsFailing > report.targetsTotal / 2 ? 'FAIL' : 'PASS';
}
