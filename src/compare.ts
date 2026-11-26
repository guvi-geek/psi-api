/**
 * The keep / revert / inconclusive call an agent otherwise computes by hand.
 *
 * Judged on the metric that was changed, against that metric's own range.
 * The score's range is built from every metric at once, and using it
 * for an LCP change asks for a margin the LCP may be unable to show.
 */

import type { AggregatedReport, MetricKey, NetworkRequest, SeriesStats } from './types.js';
import { pageDocument } from './rows.js';

export type CompareVerdict = 'KEEP' | 'REVERT' | 'INCONCLUSIVE';

export interface RequestDiff {
  available: boolean;
  documentBytesBefore: number | null;
  documentBytesAfter: number | null;
  notFoundResolved: string[];
  notFoundIntroduced: string[];
  thirdPartyArrived: string[];
  thirdPartyLeft: string[];
}

/** One side of a comparison, reduced to the observed range. */
export interface CompareSide {
  min: number;
  max: number;
  /** Worst end of the range: `max` for budgets, `min` for the score. */
  tail: number;
  passRate?: number;
}

export interface CompareResult {
  metric: string;
  verdict: CompareVerdict;
  reason: string;
  /** Positive when the after report is better on this metric's worst run. */
  tailDelta: number;
  before: CompareSide;
  after: CompareSide;
  bimodal: boolean;
  requests: RequestDiff;
  cautions: string[];
}

const LOWER_IS_BETTER = new Set<string>([
  'lcp',
  'fcp',
  'tbt',
  'cls',
  'speedIndex',
  'tti',
  'ttfb',
  'inp',
]);

function seriesOf(report: AggregatedReport, metric: string): SeriesStats | undefined {
  if (metric === 'score') return report.score;
  return report.metrics[metric as MetricKey];
}

function passRateOf(report: AggregatedReport, metric: string): number | undefined {
  return report.targets.gaps.find((gap) => gap.metric === metric)?.passRate;
}

function meetsOf(report: AggregatedReport, metric: string): boolean | undefined {
  return report.targets.gaps.find((gap) => gap.metric === metric)?.meets;
}

function requestKey(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.host}${path}`;
  } catch {
    return url;
  }
}

function notFoundKeys(requests: NetworkRequest[]): Set<string> {
  return new Set(requests.filter((request) => request.statusCode === 404).map((request) => requestKey(request.url)));
}

function thirdPartyHosts(requests: NetworkRequest[]): Set<string> {
  const hosts = new Set<string>();
  for (const request of requests) {
    if (request.party !== 'third') continue;
    try {
      hosts.add(new URL(request.url).host);
    } catch {
      if (request.entity) hosts.add(request.entity);
    }
  }
  return hosts;
}

function documentBytes(report: AggregatedReport): number | null {
  if (!report.requests || report.requests.length === 0) return null;
  const page = pageDocument(report.requests, report.url, report.finalUrl);
  return page?.transferSize ?? null;
}

export function diffRequests(
  before: AggregatedReport,
  after: AggregatedReport,
): RequestDiff {
  if (!before.requests || !after.requests) {
    return {
      available: false,
      documentBytesBefore: null,
      documentBytesAfter: null,
      notFoundResolved: [],
      notFoundIntroduced: [],
      thirdPartyArrived: [],
      thirdPartyLeft: [],
    };
  }
  const beforeMissing = notFoundKeys(before.requests);
  const afterMissing = notFoundKeys(after.requests);
  const beforeHosts = thirdPartyHosts(before.requests);
  const afterHosts = thirdPartyHosts(after.requests);
  return {
    available: true,
    documentBytesBefore: documentBytes(before),
    documentBytesAfter: documentBytes(after),
    notFoundResolved: [...beforeMissing].filter((url) => !afterMissing.has(url)).sort(),
    notFoundIntroduced: [...afterMissing].filter((url) => !beforeMissing.has(url)).sort(),
    thirdPartyArrived: [...afterHosts].filter((host) => !beforeHosts.has(host)).sort(),
    thirdPartyLeft: [...beforeHosts].filter((host) => !afterHosts.has(host)).sort(),
  };
}

/**
 * Which metric to judge when the caller did not name one: the worst failing
 * lab metric on the baseline, then LCP, then the score.
 */
export function defaultCompareMetric(before: AggregatedReport): string {
  const failing = before.targets.gaps.find((gap) => !gap.meets && gap.metric !== 'score');
  if (failing) return failing.metric;
  if (before.metrics.lcp) return 'lcp';
  return 'score';
}

export function compareReports(before: AggregatedReport, after: AggregatedReport, metric: string): CompareResult {
  const requests = diffRequests(before, after);
  const cautions: string[] = [];
  if (requests.notFoundIntroduced.length > 0) {
    cautions.push(
      `New 404s appeared (${requests.notFoundIntroduced.join(', ')}). A KEEP is unconfirmed until those files load.`,
    );
  }
  const earlier = seriesOf(before, metric);
  const later = seriesOf(after, metric);
  const lowerIsBetter = LOWER_IS_BETTER.has(metric);
  const sideOf = (stats: SeriesStats | undefined, report: AggregatedReport): CompareSide => {
    const min = stats?.min ?? 0;
    const max = stats?.max ?? 0;
    return { min, max, tail: lowerIsBetter ? max : min, passRate: passRateOf(report, metric) };
  };
  const base = {
    metric,
    requests,
    cautions,
    bimodal: false,
    tailDelta: 0,
    before: sideOf(earlier, before),
    after: sideOf(later, after),
  };
  if (!earlier || !later) {
    return {
      ...base,
      verdict: 'INCONCLUSIVE',
      reason: `${metric} was not measured on both reports, so there is nothing to judge.`,
    };
  }

  const better = lowerIsBetter
    ? base.before.tail - base.after.tail
    : base.after.tail - base.before.tail;
  const distribution = (report: AggregatedReport) =>
    metric === 'score' ? report.distributions?.score : report.distributions?.[metric as MetricKey];
  const bimodal = Boolean(distribution(before)?.bimodal || distribution(after)?.bimodal);
  const beforeRate = base.before.passRate;
  const afterRate = base.after.passRate;
  const passImproved = beforeRate !== undefined && afterRate !== undefined && afterRate > beforeRate + 1e-9;
  const stillMissing = meetsOf(after, metric) === false;
  const shaped = { ...base, bimodal, tailDelta: better };

  if (bimodal) {
    if (passImproved && better >= 0) {
      return {
        ...shaped,
        verdict: 'KEEP',
        reason: `${metric} splits into two groups, but more runs landed inside the budget and the worst run did not get worse.`,
      };
    }
    if (better < 0 && stillMissing) {
      return {
        ...shaped,
        verdict: 'REVERT',
        reason: `${metric} splits into two groups, and the worst run still moved the wrong way while the target stays missed.`,
      };
    }
    return {
      ...shaped,
      verdict: 'INCONCLUSIVE',
      reason: `${metric} splits into two groups, so its range is not a noise band. Compare lane to lane before keeping a change.`,
    };
  }

  // The baseline's range width is the noise band. It is derived from min/max
  // only, so a report does not need a separate spread statistic to be judged.
  const noise = earlier.max - earlier.min;
  if (better > noise) {
    return {
      ...shaped,
      verdict: 'KEEP',
      reason: `worst run improved by ${round(better)}, which is past the baseline range of ${round(noise)}.`,
    };
  }
  if (better < -noise) {
    return {
      ...shaped,
      verdict: 'REVERT',
      reason: `worst run got worse by ${round(-better)}, past the baseline range of ${round(noise)}.`,
    };
  }
  if (better <= 0 && stillMissing) {
    return {
      ...shaped,
      verdict: 'REVERT',
      reason: `${metric} is flat or worse and still misses its target.`,
    };
  }
  if (passImproved && better >= 0) {
    return {
      ...shaped,
      verdict: 'KEEP',
      reason: `worst run stayed inside the noise, but more runs landed inside the ${metric} budget.`,
    };
  }
  return {
    ...shaped,
    verdict: 'INCONCLUSIVE',
    reason: `worst run moved by ${round(better)}, inside the baseline range of ${round(noise)}. Re-measure once; if it stays here, revert.`,
  };
}

function round(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}
