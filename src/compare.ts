/**
 * The keep / revert / inconclusive call an agent otherwise computes by hand.
 *
 * Judged on the metric that was changed, against that metric's own spread.
 * The score's stddev is a band built from every metric at once, and using it
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

export interface CompareResult {
  metric: string;
  verdict: CompareVerdict;
  reason: string;
  /** Positive when the after report is better on this metric. */
  p75Delta: number;
  before: { p75: number; stddev: number; passRate?: number };
  after: { p75: number; stddev: number; passRate?: number };
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
  const base = {
    metric,
    requests,
    cautions,
    bimodal: false,
    p75Delta: 0,
    before: { p75: earlier?.p75 ?? 0, stddev: earlier?.stddev ?? 0, passRate: passRateOf(before, metric) },
    after: { p75: later?.p75 ?? 0, stddev: later?.stddev ?? 0, passRate: passRateOf(after, metric) },
  };
  if (!earlier || !later) {
    return {
      ...base,
      verdict: 'INCONCLUSIVE',
      reason: `${metric} was not measured on both reports, so there is nothing to judge.`,
    };
  }

  const better = LOWER_IS_BETTER.has(metric) ? earlier.p75 - later.p75 : later.p75 - earlier.p75;
  const distribution = (report: AggregatedReport) =>
    metric === 'score' ? report.distributions?.score : report.distributions?.[metric as MetricKey];
  const bimodal = Boolean(distribution(before)?.bimodal || distribution(after)?.bimodal);
  const beforeRate = passRateOf(before, metric);
  const afterRate = passRateOf(after, metric);
  const passImproved = beforeRate !== undefined && afterRate !== undefined && afterRate > beforeRate + 1e-9;
  const stillMissing = meetsOf(after, metric) === false;
  const shaped = {
    ...base,
    bimodal,
    p75Delta: better,
    before: { p75: earlier.p75, stddev: earlier.stddev, passRate: beforeRate },
    after: { p75: later.p75, stddev: later.stddev, passRate: afterRate },
  };

  if (bimodal) {
    if (passImproved && better >= 0) {
      return {
        ...shaped,
        verdict: 'KEEP',
        reason: `${metric} splits into two groups, but more runs landed inside the budget and p75 did not get worse.`,
      };
    }
    if (better < 0 && stillMissing) {
      return {
        ...shaped,
        verdict: 'REVERT',
        reason: `${metric} splits into two groups, and p75 still moved the wrong way while the target stays missed.`,
      };
    }
    return {
      ...shaped,
      verdict: 'INCONCLUSIVE',
      reason: `${metric} splits into two groups, so its stddev is not a noise band. Compare lane to lane before keeping a change.`,
    };
  }

  const noise = earlier.stddev;
  if (better > noise) {
    return {
      ...shaped,
      verdict: 'KEEP',
      reason: `p75 improved by ${round(better)}, which is past the baseline stddev of ${round(noise)}.`,
    };
  }
  if (better < -noise) {
    return {
      ...shaped,
      verdict: 'REVERT',
      reason: `p75 got worse by ${round(-better)}, past the baseline stddev of ${round(noise)}.`,
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
      reason: `p75 stayed inside the noise, but more runs landed inside the ${metric} budget.`,
    };
  }
  return {
    ...shaped,
    verdict: 'INCONCLUSIVE',
    reason: `p75 moved by ${round(better)}, inside the baseline stddev of ${round(noise)}. Re-measure once; if it stays here, revert.`,
  };
}

function round(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}
