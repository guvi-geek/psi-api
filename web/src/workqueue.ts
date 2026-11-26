/**
 * The Work queue (--diagnose) and Requests (--requests) tabs, worked out from
 * the server's diagnosis and the stored report with the CLI's own helpers.
 * No React here: tests import it.
 */
import type { Gap, ImageFinding, LcpDetail, NetworkRequest } from '../../src/types';
import type { Diagnosis, RankedInsight } from '../../src/diagnose';
import { ABSENT, formatBytes, medianOverTarget, metricDelta, metricValue, passCount, passSeverity, savingsLabel } from '../../src/render';
import { requestSummary } from '../../src/rows';
import { METRIC_NAMES, METRIC_SHORT, type Severity } from './overview';

const SEVERITY: Record<'green' | 'yellow' | 'red', Severity> = { green: 'good', yellow: 'warn', red: 'bad' };

/* ------------------------------- work queue ------------------------------- */

export interface WorkQueueFilters {
  party: 'any' | 'first' | 'third';
  minFirstPartyRatio?: number;
  sortBy: 'savingsMs' | 'savingsBytes' | 'score' | 'firstPartyShare';
  limit?: number;
  noFlaky: boolean;
}

export const DEFAULT_QUEUE: WorkQueueFilters = { party: 'any', sortBy: 'savingsMs', noFlaky: false };

/** The flags --diagnose honours. `group` is left to the diagnosis, as the CLI does. */
export function queueFromParams(params: URLSearchParams): WorkQueueFilters {
  const filters: WorkQueueFilters = { ...DEFAULT_QUEUE };
  const party = params.get('party');
  if (party === 'first' || party === 'third') filters.party = party;
  const sortBy = params.get('sortBy');
  if (sortBy === 'savingsBytes' || sortBy === 'score' || sortBy === 'firstPartyShare') filters.sortBy = sortBy;
  const ratio = Number(params.get('minFirstPartyRatio') ?? NaN);
  if (params.get('minFirstPartyRatio') !== null && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1) filters.minFirstPartyRatio = ratio;
  const limit = Number(params.get('limit') ?? NaN);
  if (params.get('limit') !== null && Number.isInteger(limit) && limit >= 0) filters.limit = limit;
  filters.noFlaky = params.get('noFlaky') === '1';
  return filters;
}

export function queueToParams(filters: WorkQueueFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.party !== 'any') params.set('party', filters.party);
  if (filters.minFirstPartyRatio !== undefined) params.set('minFirstPartyRatio', String(filters.minFirstPartyRatio));
  if (filters.sortBy !== 'savingsMs') params.set('sortBy', filters.sortBy);
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  if (filters.noFlaky) params.set('noFlaky', '1');
  return params;
}

/** Query for GET /report/:id/diagnosis. */
export function queueToApiQuery(filters: WorkQueueFilters): string {
  const params = new URLSearchParams({ party: filters.party, sortBy: filters.sortBy, includeFlaky: String(!filters.noFlaky) });
  if (filters.minFirstPartyRatio !== undefined) params.set('minFirstPartyRatio', String(filters.minFirstPartyRatio));
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  return params.toString();
}

export function queueToCli(reportId: string, filters: WorkQueueFilters): string {
  const args = ['npm run psi --', `--reportId ${reportId}`, '--diagnose'];
  if (filters.party !== 'any') args.push(`--party ${filters.party}`);
  if (filters.minFirstPartyRatio !== undefined) args.push(`--minFirstPartyRatio ${filters.minFirstPartyRatio}`);
  if (filters.sortBy !== 'savingsMs') args.push(`--sortBy ${filters.sortBy}`);
  if (filters.limit !== undefined) args.push(`--limit ${filters.limit}`);
  if (filters.noFlaky) args.push('--noFlaky');
  return args.join(' ');
}

export interface GapRow {
  metric: string;
  name: string;
  value: string;
  target: string;
  verdict: string;
  over: boolean;
  runsInTarget: string;
  severity: Severity;
}

/** One failing target, with the CLI's value, verdict and runs-in-target colour. */
export function gapRow(gap: Gap): GapRow {
  return {
    metric: gap.metric,
    name: `${METRIC_NAMES[gap.metric] ?? gap.metric} (${METRIC_SHORT[gap.metric] ?? gap.metric})`,
    value: metricValue(gap.metric, gap.actual),
    target: metricValue(gap.metric, gap.target),
    verdict: metricDelta(gap.metric, gap.delta),
    over: medianOverTarget(gap),
    runsInTarget: passCount(gap),
    severity: SEVERITY[passSeverity(gap)],
  };
}

export interface QueueRow {
  rank: number;
  id: string;
  title: string;
  saving: string;
  flaky: boolean;
  /** "unknown" when Lighthouse tied no rows to a URL, as the CLI prints. */
  ours: string;
  oursTone: 'good' | 'warn' | 'dim';
  affects: string;
  reason: string;
  sop?: { sop: string; action: string };
  estimateFromText: boolean;
}

export function queueRow(entry: RankedInsight): QueueRow {
  const share = entry.firstPartyShare;
  return {
    rank: entry.rank,
    id: entry.insight.id,
    title: entry.insight.title,
    saving: savingsLabel(entry.insight.savingsMs, entry.insight.savingsBytes),
    flaky: entry.insight.flaky,
    ours: share === null ? 'unknown' : `${Math.round(share * 100)}%`,
    oursTone: share === null ? 'dim' : share < 1 ? 'warn' : 'good',
    affects: entry.affectsFailing.map((metric) => METRIC_SHORT[metric] ?? metric).join(' ') || ABSENT,
    reason: entry.reason,
    sop: entry.sop,
    estimateFromText: entry.estimateFromText,
  };
}

export interface LcpView {
  kind: 'text' | 'image';
  tag: string;
  selector?: string;
  /** Visible text, or the alt text for an image. */
  label?: { text: string; isAlt: boolean };
  /** Phases in timeline order, with their share of the total for a stacked bar. */
  phases: Array<{ key: string; name: string; ms: number; share: number }>;
  totalMs: number;
  bottleneck: LcpDetail['bottleneck'];
}

const PHASE_NAMES: Record<string, string> = {
  ttfb: 'Server response (TTFB)',
  loadDelay: 'Load delay',
  loadTime: 'Load time',
  renderDelay: 'Render delay',
};

/** The CLI's LCP ELEMENT block. Phases stay in timeline order, never sorted by size. */
export function lcpView(lcp: LcpDetail | null): LcpView | null {
  if (!lcp) return null;
  const entries = Object.entries(lcp.phases).filter((entry): entry is [string, number] => typeof entry[1] === 'number');
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  return {
    kind: lcp.isText ? 'text' : 'image',
    tag: (lcp.elementType ?? '?').toLowerCase(),
    selector: lcp.selector,
    label: lcp.text ? { text: lcp.text, isAlt: !lcp.isText } : undefined,
    phases: entries.map(([key, ms]) => ({ key, name: PHASE_NAMES[key] ?? key, ms: Math.round(ms), share: total > 0 ? ms / total : 0 })),
    totalMs: Math.round(total),
    bottleneck: lcp.bottleneck,
  };
}

/** The CLI's IMAGE CHECKS labels. */
export const IMAGE_KIND_LABELS: Record<ImageFinding['kind'], string> = {
  oversized: 'Oversized',
  heavyImage: 'Heavy',
  srcsetWithoutSizes: 'No sizes',
  eagerOffscreen: 'Eager offscreen',
  lazyInFirstFold: 'Lazy in first fold',
  multipleHighPriority: 'Priority',
  compression: 'Format',
};

export interface ImageRow {
  label: string;
  /** An oversized image the device-pixel correction clears: shown as fine, as the CLI does. */
  fine: boolean;
  size?: string;
  where: string;
  detail: string;
}

export function imageRow(finding: ImageFinding): ImageRow {
  const fine = finding.kind === 'oversized' && finding.real === false;
  return {
    label: fine ? 'Fine' : IMAGE_KIND_LABELS[finding.kind],
    fine,
    size: finding.bytes ? formatBytes(finding.bytes) : undefined,
    where: finding.url ?? finding.selector ?? '',
    detail: finding.detail,
  };
}

/** The tail-only failures: median inside the target, too few runs inside it. */
export function unreliableText(diagnosis: Pick<Diagnosis, 'unreliable'>): string[] {
  return diagnosis.unreliable.map(
    (gap) => `${METRIC_SHORT[gap.metric] ?? gap.metric}: median ${metricValue(gap.metric, gap.actual)} is inside ${metricValue(gap.metric, gap.target)}, but only ${passCount(gap)} runs are`,
  );
}

/* -------------------------------- requests -------------------------------- */

export interface RequestFilters {
  party: 'any' | 'first' | 'third';
  sortBy: 'start' | 'size';
  limit?: number;
}

export const DEFAULT_REQUESTS: RequestFilters = { party: 'any', sortBy: 'start' };

export function requestsFromParams(params: URLSearchParams): RequestFilters {
  const filters: RequestFilters = { ...DEFAULT_REQUESTS };
  const party = params.get('party');
  if (party === 'first' || party === 'third') filters.party = party;
  if (params.get('order') === 'size') filters.sortBy = 'size';
  const limit = Number(params.get('limit') ?? NaN);
  if (params.get('limit') !== null && Number.isInteger(limit) && limit >= 0) filters.limit = limit;
  return filters;
}

export function requestsToParams(filters: RequestFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.party !== 'any') params.set('party', filters.party);
  if (filters.sortBy === 'size') params.set('order', 'size');
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  return params;
}

export function requestsToCli(reportId: string, filters: RequestFilters): string {
  const args = ['npm run psi --', `--reportId ${reportId}`, filters.sortBy === 'size' ? '--requests size' : '--requests'];
  if (filters.party !== 'any') args.push(`--party ${filters.party}`);
  if (filters.limit !== undefined) args.push(`--limit ${filters.limit}`);
  return args.join(' ');
}

export interface RequestRow {
  url: string;
  start: string;
  end: string;
  type: string;
  priority: string;
  size: string;
  /** Uncompressed size, JSON-only in the CLI. */
  resourceSize: string;
  status: string;
  notFound: boolean;
  preload: boolean;
  party: 'first' | 'third';
  entity?: string;
  mimeType?: string;
}

/** The same rows, in the same order, that renderRequests prints. */
export function requestRows(
  requests: NetworkRequest[] | null | undefined,
  filters: RequestFilters,
): { rows: RequestRow[]; matched: number } {
  const all = requests ?? [];
  let shown = all.filter((request) => filters.party === 'any' || request.party === filters.party);
  if (filters.sortBy === 'size') shown = [...shown].sort((a, b) => (b.transferSize ?? 0) - (a.transferSize ?? 0));
  const matched = shown.length;
  if (filters.limit !== undefined) shown = shown.slice(0, filters.limit);
  const ms = (value: number | undefined) => (value === undefined ? ABSENT : `${Math.round(value)}`);
  return {
    matched,
    rows: shown.map((request) => ({
      url: request.url,
      start: ms(request.startMs),
      end: ms(request.endMs),
      type: request.resourceType ?? ABSENT,
      priority: request.priority ?? ABSENT,
      size: formatBytes(request.transferSize),
      resourceSize: formatBytes(request.resourceSize),
      status: request.statusCode === undefined ? ABSENT : String(request.statusCode),
      notFound: request.statusCode === 404,
      preload: Boolean(request.isLinkPreload),
      party: request.party,
      entity: request.entity,
      mimeType: request.mimeType,
    })),
  };
}

export interface RequestTotals {
  count: number;
  bytes: string;
  first: { count: number; bytes: string };
  third: { count: number; bytes: string };
  notFound: number;
  byType: Array<{ type: string; count: number; bytes: string }>;
}

/** The CLI's REQUESTS summary line, from its own requestSummary. */
export function requestTotals(requests: NetworkRequest[]): RequestTotals {
  const summary = requestSummary(requests);
  return {
    count: summary.count,
    bytes: formatBytes(summary.bytes),
    first: { count: summary.byParty.first.count, bytes: formatBytes(summary.byParty.first.bytes) },
    third: { count: summary.byParty.third.count, bytes: formatBytes(summary.byParty.third.bytes) },
    notFound: requests.filter((request) => request.statusCode === 404).length,
    byType: summary.byType.map((entry) => ({ type: entry.type, count: entry.count, bytes: formatBytes(entry.bytes) })),
  };
}

/* ---------------------------------- json ---------------------------------- */

/** Top-level keys of the stored report with their size, for the JSON tab's section picker. */
export function jsonSections(report: object): Array<{ key: string; bytes: number }> {
  return Object.entries(report).map(([key, value]) => ({ key, bytes: JSON.stringify(value)?.length ?? 0 }));
}
