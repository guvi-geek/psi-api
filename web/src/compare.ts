/**
 * Compare (--compare) and Re-analyze (--reanalyze). The verdict and the rebuild
 * run on the server with the CLI's own code (compareReports, reanalyze); this
 * only turns their results into words. No React here: tests import it.
 */
import type { CompareResult } from '../../src/compare';
import type { ReanalyzeDelta } from '../../src/reanalyze';
import { formatBytes, metricValue } from '../../src/render';
import { METRIC_NAMES, METRIC_SHORT } from './overview';
import { measuredAt, type ReportRow } from './run';

/** The metrics --compare --metric accepts. The score is not one of them. */
export const COMPARE_METRICS = ['lcp', 'fcp', 'tbt', 'cls', 'speedIndex', 'tti', 'ttfb', 'inp'] as const;
export type CompareMetric = (typeof COMPARE_METRICS)[number];

export type CompareResponse = CompareResult & { beforeId: string; afterId: string };

export function isCompareMetric(value: string | null | undefined): value is CompareMetric {
  return Boolean(value) && (COMPARE_METRICS as readonly string[]).includes(value!);
}

export function compareQuery(before: string, after: string, metric?: CompareMetric): string {
  const params = new URLSearchParams({ before, after });
  if (metric) params.set('metric', metric);
  return params.toString();
}

export function compareCli(before: string, after: string, metric?: string): string {
  return `npm run psi -- --compare ${before} ${after}${metric ? ` --metric ${metric}` : ''}`;
}

export const VERDICT_TONE: Record<CompareResult['verdict'], 'good' | 'bad' | 'warn'> = {
  KEEP: 'good',
  REVERT: 'bad',
  INCONCLUSIVE: 'warn',
};

/** "312ms better" or "0.020 worse": p75Delta is positive when the after report is better. */
export function changeText(metric: string, p75Delta: number): string {
  if (p75Delta === 0) return 'No change at p75';
  const size = metric === 'cls' ? Math.abs(p75Delta).toFixed(3) : `${Math.round(Math.abs(p75Delta))}ms`;
  return `${size} ${p75Delta > 0 ? 'better' : 'worse'} at p75`;
}

export interface CompareSide {
  label: 'Before' | 'After';
  reportId: string;
  p75: string;
  stddev: string;
  passRate: string;
}

export function compareSides(result: CompareResponse): CompareSide[] {
  const side = (label: CompareSide['label'], reportId: string, stats: CompareResult['before']): CompareSide => ({
    label,
    reportId,
    p75: metricValue(result.metric, stats.p75),
    stddev: metricValue(result.metric, stats.stddev),
    passRate: stats.passRate === undefined ? '—' : `${Math.round(stats.passRate * 100)}% of runs in target`,
  });
  return [side('Before', result.beforeId, result.before), side('After', result.afterId, result.after)];
}

export interface RequestChange {
  label: string;
  items: string[];
}

/** The CLI's REQUESTS block of --compare, or null when a report has no request table. */
export function requestChanges(result: CompareResponse): { document: string; changes: RequestChange[] } | null {
  const diff = result.requests;
  if (!diff.available) return null;
  const bytes = (value: number | null) => (value === null ? '—' : formatBytes(value));
  return {
    document: `${bytes(diff.documentBytesBefore)} → ${bytes(diff.documentBytesAfter)}`,
    changes: [
      { label: '404s resolved', items: diff.notFoundResolved },
      { label: '404s introduced', items: diff.notFoundIntroduced },
      { label: 'Third parties arrived', items: diff.thirdPartyArrived },
      { label: 'Third parties left', items: diff.thirdPartyLeft },
    ],
  };
}

export function metricLabel(metric: string): string {
  return `${METRIC_NAMES[metric] ?? metric} (${METRIC_SHORT[metric] ?? metric})`;
}

/** How a report reads in a picker: page, device, when, score. */
export function reportOption(report: ReportRow): string {
  const when = measuredAt(report.reportId, report.generatedAt).slice(0, 16).replace('T', ' ');
  return `${report.url.replace(/^https?:\/\//, '')}, ${report.strategy}, ${when}, score ${Math.round(report.score)}`;
}

/** The report measured just before this one, of the same page on the same device. */
export function previousOf(reports: ReportRow[], reportId: string): ReportRow | undefined {
  const current = reports.find((report) => report.reportId === reportId);
  if (!current) return undefined;
  // /reports is newest first, so the next match after this one is the one before it.
  const index = reports.indexOf(current);
  return reports
    .slice(index + 1)
    .find((report) => report.url === current.url && report.strategy === current.strategy);
}

/** Two reports that measure different pages or devices: the verdict is still given, but read it with care. */
export function mismatch(before?: ReportRow, after?: ReportRow): string | null {
  if (!before || !after) return null;
  if (before.reportId === after.reportId) return 'Before and after are the same report.';
  const parts: string[] = [];
  if (before.url !== after.url) parts.push('different pages');
  if (before.strategy !== after.strategy) parts.push('different devices');
  return parts.length ? `These reports measure ${parts.join(' and ')}.` : null;
}

/* ------------------------------- re-analyze ------------------------------- */

export interface ReanalyzeRow {
  reportId: string;
  delta: ReanalyzeDelta | null;
  error?: string;
  saved: boolean;
}

/**
 * The reports a save should rewrite: those the preview found changed. The
 * CLI's bare --reanalyze rewrites every report, which re-stamps unchanged ones.
 */
export function idsToSave(rows: ReanalyzeRow[]): string[] {
  return rows.filter((row) => row.delta?.changed && !row.error).map((row) => row.reportId);
}

/** The CLI's RE-ANALYZED header numbers. */
export function reanalyzeSummary(rows: ReanalyzeRow[]): {
  total: number;
  changed: number;
  recovered: number;
  phantoms: number;
  failed: number;
  saved: number;
} {
  return {
    total: rows.length,
    changed: rows.filter((row) => row.delta?.changed).length,
    recovered: rows.reduce((sum, row) => sum + (row.delta?.recovered.length ?? 0), 0),
    phantoms: rows.reduce((sum, row) => sum + (row.delta?.phantomZeroes.length ?? 0), 0),
    failed: rows.filter((row) => row.error).length,
    saved: rows.filter((row) => row.saved).length,
  };
}

/** One line per change in a rebuilt report, in the CLI's words. */
export function reanalyzeLines(delta: ReanalyzeDelta): Array<{ tone: 'good' | 'warn' | 'bad'; text: string }> {
  const lines: Array<{ tone: 'good' | 'warn' | 'bad'; text: string }> = [];
  for (const change of delta.recovered) {
    const bytes = change.afterBytes !== change.beforeBytes ? ` / ${formatBytes(change.afterBytes)}` : '';
    const where =
      change.source === 'none' || change.source === undefined
        ? 'provenance not recoverable from the stored run'
        : `found in ${change.source}`;
    const measured = change.afterMs === null ? 'no time saving' : `${change.afterMs}ms`;
    lines.push({
      tone: 'good',
      text: `Recovered ${change.insightId}: recorded as 0, Lighthouse actually measured ${measured}${bytes} (${where})`,
    });
  }
  for (const phantom of delta.phantomZeroes) {
    lines.push({ tone: 'warn', text: `Corrected ${phantom}: claimed a 0ms saving that Lighthouse never gave an estimate for` });
  }
  if (delta.failingBefore.join(',') !== delta.failingAfter.join(',')) {
    const now = delta.failingAfter.map((metric) => METRIC_SHORT[metric] ?? metric).join(', ') || 'nothing';
    lines.push({ tone: 'bad', text: `Now failing: ${now}` });
  }
  return lines;
}
