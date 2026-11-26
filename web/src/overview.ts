/**
 * What the report Overview shows, worked out from a stored report.
 *
 * Every number and judgement comes from the CLI's own helpers in src/render.ts,
 * src/readout.ts and src/rows.ts, so the page and the terminal cannot disagree
 * on a value, a bar, a run count or a verdict. No React here: tests import it.
 */
import type { AggregatedReport, Gap, MetricKey, NetworkRequest, SeriesStats } from '../../src/types';
import {
  medianOverTarget,
  metricDelta,
  metricValue,
  passCount,
  passSeverity,
  targetBar,
  METRIC_ROWS,
} from '../../src/render';
import { fieldDataPresent, fieldP75 } from '../../src/readout';
import { pageDocument } from '../../src/rows';

export type Report = AggregatedReport;

/** Full names for the page; the CLI's abbreviations stay beside them. */
export const METRIC_NAMES: Record<string, string> = {
  score: 'Score',
  fcp: 'First contentful paint',
  lcp: 'Largest contentful paint',
  speedIndex: 'Speed index',
  tbt: 'Total blocking time',
  cls: 'Cumulative layout shift',
  tti: 'Time to interactive',
  ttfb: 'Time to first byte',
  inp: 'Interaction to next paint',
};

export const METRIC_SHORT: Record<string, string> = {
  score: 'Score',
  fcp: 'FCP',
  lcp: 'LCP',
  speedIndex: 'SI',
  tbt: 'TBT',
  cls: 'CLS',
  tti: 'TTI',
  ttfb: 'TTFB',
  inp: 'INP',
};

export type Severity = 'good' | 'warn' | 'bad';

const SEVERITY: Record<'green' | 'yellow' | 'red', Severity> = { green: 'good', yellow: 'warn', red: 'bad' };

/** Relative overshoot, the CLI's ranking for naming failures worst first. */
function overshoot(gap: Gap): number {
  if (gap.target <= 0) return gap.delta > 0 ? Number.POSITIVE_INFINITY : 0;
  return gap.delta / gap.target;
}

export interface VerdictSummary {
  word: 'PASS' | 'FAIL';
  failing: number;
  total: number;
  /** Up to four failing targets, worst relative overshoot first. */
  named: Array<{ metric: string; text: string }>;
  /** Every median is inside budget but too few runs are: graded on the tail. */
  tailOnly: boolean;
  /** Budgets the server round trip alone already exceeds. */
  blockedBy: string[];
}

export function verdictSummary(report: Report): VerdictSummary {
  const gaps = report.targets.gaps;
  const failing = gaps.filter((gap) => !gap.meets);
  const named = failing
    .slice()
    .sort((a, b) => overshoot(b) - overshoot(a))
    .slice(0, 4)
    .map((gap) => {
      const count = passCount(gap);
      const held = count === '—' ? '' : ` (${count} runs in target)`;
      return {
        metric: gap.metric,
        text: `${METRIC_SHORT[gap.metric] ?? gap.metric} ${metricValue(gap.metric, gap.actual)} vs ${metricValue(gap.metric, gap.target)}${held}`,
      };
    });
  return {
    // "3 of 6" is exactly half, which is not a FAIL.
    word: failing.length > gaps.length / 2 ? 'FAIL' : 'PASS',
    failing: failing.length,
    total: gaps.length,
    named,
    tailOnly: Boolean(report.targets.medianPass && !report.targets.meetsTarget),
    blockedBy: report.targets.blockedBy ?? [],
  };
}

export interface SpreadItem {
  label: string;
  value: string;
}

/** p25, p75, p95, range and stddev: the parts of the CLI's spread line. */
export function spreadItems(stats: SeriesStats | undefined, metric: string): SpreadItem[] {
  if (!stats) return [];
  const items: SpreadItem[] = [
    { label: 'p25', value: metricValue(metric, stats.p25) },
    { label: 'p75', value: metricValue(metric, stats.p75) },
    { label: 'p95', value: metricValue(metric, stats.p95) },
    { label: 'Range', value: `${metricValue(metric, stats.min)}–${metricValue(metric, stats.max)}` },
  ];
  if (Number.isFinite(stats.stddev)) items.push({ label: 'Stddev', value: stats.stddev.toFixed(1) });
  return items;
}

export interface MetricRow {
  key: MetricKey;
  name: string;
  short: string;
  value: string;
  target: string;
  /** "+191ms over" or "in target", judged on the headline value only. */
  verdict: string;
  over: boolean;
  hasTarget: boolean;
  /** Share of the target, as printed by the CLI. */
  percent: string;
  /** Bar geometry on the CLI's fixed 0-200% ruler; the target sits at 50%. */
  bar: { fillPercent: number; over: boolean };
  runsInTarget: string;
  severity: Severity;
  spread: SpreadItem[];
  values: string[];
  bimodalNote?: string;
}

/** One row per graded metric, in the CLI's order. The score has its own block. */
export function metricRows(report: Report): MetricRow[] {
  const byMetric = new Map(report.targets.gaps.map((gap) => [gap.metric, gap]));
  return METRIC_ROWS.filter((row) => report.headline.metrics[row.key] !== undefined).map((row) => {
    const gap = byMetric.get(row.key);
    const actual = gap?.actual ?? report.headline.metrics[row.key] ?? 0;
    const target = gap?.target ?? 0;
    const bar = targetBar(actual, target);
    const over = medianOverTarget(gap);
    const stats = report.metrics[row.key];
    const split = report.distributions?.[row.key];
    return {
      key: row.key,
      name: METRIC_NAMES[row.key] ?? row.label,
      short: METRIC_SHORT[row.key] ?? row.label,
      value: metricValue(row.key, actual),
      target: gap ? metricValue(row.key, gap.target) : '—',
      verdict: gap ? metricDelta(row.key, gap.delta) : '—',
      over,
      hasTarget: Boolean(gap),
      percent: gap ? `${Math.round(bar.used * 100)}%` : '—',
      bar: { fillPercent: Math.min(100, Math.max(0, (bar.used / 2) * 100)), over },
      runsInTarget: gap ? passCount(gap) : '—',
      severity: gap ? SEVERITY[passSeverity(gap)] : 'good',
      spread: spreadItems(stats, row.key),
      values: (stats?.values ?? []).map((value) => metricValue(row.key, value)),
      bimodalNote: split?.bimodal && split.note ? split.note : undefined,
    };
  });
}

export interface ScoreSummary {
  value: number;
  target?: number;
  severity: Severity;
  spread: SpreadItem[];
  values: number[];
  bimodalNote?: string;
}

export function scoreSummary(report: Report): ScoreSummary {
  const score = Math.round(report.headline.score);
  const split = report.distributions?.score;
  return {
    value: score,
    target: report.targets.targets.score,
    severity: score >= 90 ? 'good' : score >= 50 ? 'warn' : 'bad',
    spread: spreadItems(report.score, 'score'),
    values: report.score?.values ?? [],
    bimodalNote: split?.bimodal && split.note ? split.note : undefined,
  };
}

export interface NotFound {
  /** The measured page itself returned 404: every number describes an error page. */
  pageUrl?: string;
  /** Other files that returned 404: a broken deploy, not a slow page. */
  files: string[];
}

export function notFound(report: Report): NotFound {
  const requests: NetworkRequest[] = report.requests ?? [];
  const missing = requests.filter((request) => request.statusCode === 404);
  if (missing.length === 0) return { files: [] };
  const page = pageDocument(requests, report.url, report.finalUrl);
  return {
    pageUrl: page?.statusCode === 404 ? page.url : undefined,
    files: missing.filter((request) => request !== page).map((request) => request.url),
  };
}

export interface FieldRow {
  key: string;
  name: string;
  value: string;
}

/** CrUX real-user p75 for the measured URL. `null` when CrUX has no data. */
export function fieldRows(report: Report): FieldRow[] | null {
  if (!fieldDataPresent(report.fieldData)) return null;
  return (['lcp', 'fcp', 'cls', 'inp', 'ttfb'] as const).map((key) => {
    const value = fieldP75(report.fieldData, key);
    return { key, name: METRIC_NAMES[key] ?? key, value: value === undefined ? 'Not in CrUX' : metricValue(key, value) };
  });
}

/** Score and graded metrics under each statistic, side by side (JSON-only in the CLI). */
export function statsTable(report: Report): Array<{ key: string; name: string; mean: string; median: string; mode: string }> {
  const keys = ['score', ...METRIC_ROWS.map((row) => row.key)] as const;
  return keys
    .filter((key) => key === 'score' || report.stats.median.metrics[key] !== undefined)
    .map((key) => {
      const pick = (stat: 'mean' | 'median' | 'mode') =>
        key === 'score' ? metricValue('score', report.stats[stat].score) : metricValue(key, report.stats[stat].metrics[key]);
      return { key, name: METRIC_NAMES[key] ?? key, mean: pick('mean'), median: pick('median'), mode: pick('mode') };
    });
}

