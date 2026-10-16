/**
 * The numbers a keep-or-revert decision needs, which the metric table otherwise
 * leaves in JSON.
 */

import type { AggregatedReport, FieldData, MetricKey } from './types.js';

const CRUX_KEYS: Partial<Record<MetricKey, readonly string[]>> = {
  lcp: ['LARGEST_CONTENTFUL_PAINT_MS'],
  fcp: ['FIRST_CONTENTFUL_PAINT_MS'],
  cls: ['CUMULATIVE_LAYOUT_SHIFT_SCORE'],
  inp: ['INTERACTION_TO_NEXT_PAINT_MS', 'INTERACTION_TO_NEXT_PAINT'],
  ttfb: ['EXPERIMENTAL_TIME_TO_FIRST_BYTE', 'TIME_TO_FIRST_BYTE_MS'],
};

interface CruxMetric {
  percentile?: unknown;
}

/** CrUX p75 for one lab metric, or undefined when this origin has no field data for it. */
export function fieldP75(fieldData: FieldData | null | undefined, metric: string): number | undefined {
  const experience = fieldData?.loadingExperience;
  if (!experience || typeof experience !== 'object') return undefined;
  const metrics = (experience as { metrics?: Record<string, CruxMetric> }).metrics;
  const keys = CRUX_KEYS[metric as MetricKey];
  if (!metrics || !keys) return undefined;
  for (const key of keys) {
    const percentile = metrics[key]?.percentile;
    if (typeof percentile !== 'number' || !Number.isFinite(percentile)) continue;
    // Older PSI responses store CLS as a percentage-like integer (10 = 0.10).
    if (metric === 'cls' && percentile > 1) return percentile / 100;
    return percentile;
  }
  return undefined;
}

export function fieldDataPresent(fieldData: FieldData | null | undefined): boolean {
  const experience = fieldData?.loadingExperience;
  if (!experience || typeof experience !== 'object') return false;
  const metrics = (experience as { metrics?: Record<string, unknown> }).metrics;
  return !!metrics && Object.keys(metrics).length > 0;
}

/**
 * One line under a failing metric: its own tail, whether it splits, and field p75.
 *
 * Undefined when the metric is inside its target, so a passing row is unchanged.
 */
export function failingMetricReadout(report: AggregatedReport, metric: MetricKey): string | undefined {
  const gap = report.targets.gaps.find((entry) => entry.metric === metric);
  if (!gap || gap.meets) return undefined;

  const stats = report.metrics[metric];
  const parts: string[] = [];
  if (stats) {
    parts.push(`p75 ${formatReadout(metric, stats.p75)}`);
    parts.push(`stddev ${formatReadout(metric, stats.stddev)}`);
  }
  const split = report.distributions?.[metric];
  if (split?.bimodal && split.note) parts.push(split.note);
  if (!fieldDataPresent(report.fieldData)) {
    parts.push('no field data (CrUX is empty, usual on staging)');
  } else {
    const field = fieldP75(report.fieldData, metric);
    parts.push(field === undefined ? 'field p75 not in CrUX' : `field p75 ${formatReadout(metric, field)}`);
  }
  return parts.join(' · ');
}

function formatReadout(metric: string, value: number): string {
  if (metric === 'cls') return value.toFixed(3);
  if (metric === 'score') return String(Math.round(value * 10) / 10);
  return `${Math.round(value)}ms`;
}
