import { describe, expect, it } from 'vitest';
import { compareReports, defaultCompareMetric } from '../src/compare.js';
import { grepSeeds } from '../src/diagnose.js';
import { failingMetricReadout, fieldP75 } from '../src/readout.js';
import { assessMeasurement } from '../src/validity.js';
import { parseArgs } from '../src/cli.js';
import type { AggregatedReport, MetricKey, NetworkRequest, NormalizedReport, SeriesStats } from '../src/types.js';

function series(p75: number, stddev = 100): SeriesStats {
  return {
    mean: p75,
    median: p75,
    mode: p75,
    min: p75,
    max: p75,
    stddev,
    count: 10,
    values: [],
    p25: p75,
    p75,
    p95: p75,
  };
}

function report(options: {
  id: string;
  lcp: number;
  stddev?: number;
  meets?: boolean;
  passRate?: number;
  bimodal?: boolean;
  requests?: NetworkRequest[];
}): AggregatedReport {
  const lcp = series(options.lcp, options.stddev ?? 100);
  return {
    reportId: options.id,
    url: 'https://site.test/page',
    finalUrl: 'https://site.test/page',
    strategy: 'mobile',
    stat: 'median',
    runsRequested: 10,
    runsSucceeded: 10,
    generatedAt: '2026-10-16T00:00:00.000Z',
    lighthouseVersion: '13',
    environment: { lighthouseVersion: '13' },
    headline: { score: 80, metrics: { lcp: options.lcp } },
    score: series(80, 1),
    metrics: { lcp },
    distributions: options.bimodal ? { lcp: { bimodal: true, note: 'two groups', lanes: [], separation: 400 } } : {},
    lcp: null,
    requests: options.requests ?? [],
    stats: { mean: { score: 80, metrics: {} }, median: { score: 80, metrics: {} }, mode: { score: 80, metrics: {} } },
    insights: [],
    fieldData: null,
    targets: {
      strategy: 'mobile',
      targets: { lcp: 2500 },
      meetsTarget: options.meets ?? false,
      gaps: [
        {
          metric: 'lcp',
          actual: options.lcp,
          target: 2500,
          delta: options.lcp - 2500,
          meets: options.meets ?? false,
          passRate: options.passRate,
        },
      ],
    },
    errors: [],
  };
}

const doc = (status: number, url = 'https://site.test/page'): NetworkRequest => ({
  url,
  resourceType: 'Document',
  statusCode: status,
  transferSize: 1000,
  party: 'first',
});

describe('compareReports', () => {
  it('keeps a p75 move larger than the baseline spread', () => {
    const result = compareReports(
      report({ id: 'before', lcp: 3000, stddev: 80, passRate: 0 }),
      report({ id: 'after', lcp: 2200, stddev: 70, passRate: 0.4 }),
      'lcp',
    );
    expect(result.verdict).toBe('KEEP');
    expect(result.p75Delta).toBe(800);
  });

  it('reverts a flat miss and an inconclusive nudge inside the noise', () => {
    expect(
      compareReports(
        report({ id: 'before', lcp: 3000, stddev: 200 }),
        report({ id: 'after', lcp: 3000, stddev: 200 }),
        'lcp',
      ).verdict,
    ).toBe('REVERT');
    expect(
      compareReports(
        report({ id: 'before', lcp: 3000, stddev: 200, meets: false }),
        report({ id: 'after', lcp: 2900, stddev: 200, meets: false }),
        'lcp',
      ).verdict,
    ).toBe('INCONCLUSIVE');
  });

  it('keeps a pass-rate recovery that does not move p75', () => {
    const result = compareReports(
      report({ id: 'before', lcp: 2400, stddev: 50, meets: false, passRate: 0.4 }),
      report({ id: 'after', lcp: 2400, stddev: 50, meets: true, passRate: 0.9 }),
      'lcp',
    );
    expect(result.verdict).toBe('KEEP');
  });

  it('does not treat a bimodal metric stddev as a noise band', () => {
    const result = compareReports(
      report({ id: 'before', lcp: 3000, stddev: 400, bimodal: true }),
      report({ id: 'after', lcp: 2000, stddev: 400, bimodal: true }),
      'lcp',
    );
    expect(result.verdict).toBe('INCONCLUSIVE');
    expect(result.reason).toMatch(/two groups/);
  });

  it('diffs 404s, document bytes and third-party hosts', () => {
    const before = report({
      id: 'before',
      lcp: 3000,
      requests: [
        doc(200),
        { url: 'https://site.test/build/q-old.js', resourceType: 'Script', statusCode: 404, party: 'first' },
        { url: 'https://cdn.test/beacon.js', resourceType: 'Script', party: 'third' },
      ],
    });
    const after = report({
      id: 'after',
      lcp: 2000,
      requests: [
        { ...doc(200), transferSize: 800 },
        { url: 'https://site.test/build/q-old.js', resourceType: 'Script', statusCode: 200, party: 'first' },
        { url: 'https://new.vendor.test/a.js', resourceType: 'Script', statusCode: 404, party: 'third' },
      ],
    });
    const diff = compareReports(before, after, 'lcp').requests;
    expect(diff.documentBytesBefore).toBe(1000);
    expect(diff.documentBytesAfter).toBe(800);
    expect(diff.notFoundResolved).toEqual(['site.test/build/q-old.js']);
    expect(diff.notFoundIntroduced).toEqual(['new.vendor.test/a.js']);
    expect(diff.thirdPartyArrived).toEqual(['new.vendor.test']);
    expect(diff.thirdPartyLeft).toEqual(['cdn.test']);
  });

  it('picks the failing metric when the caller does not', () => {
    expect(defaultCompareMetric(report({ id: 'a', lcp: 4000 }))).toBe('lcp');
  });
});

describe('measurement validity', () => {
  const run = (index: number, status = 200): NormalizedReport => ({
    url: 'https://site.test/page',
    finalUrl: 'https://site.test/page',
    strategy: 'mobile',
    fetchTime: `2026-10-16T00:00:0${index}.000Z`,
    lighthouseVersion: '13',
    environment: { lighthouseVersion: '13', benchmarkIndex: index },
    score: 80,
    metrics: { lcp: 2000 },
    insights: [],
    fieldData: null,
    requests: [doc(status)],
  });

  it('accepts a normal set of runs', () => {
    const validity = assessMeasurement({
      report: report({ id: 'a', lcp: 2000, meets: true }),
      runs: [run(400), run(450)],
    });
    expect(validity.usable).toBe(true);
  });

  it('rejects a 404, a cached batch, and a wide CPU spread', () => {
    expect(
      assessMeasurement({
        report: report({ id: 'a', lcp: 2000 }),
        runs: [run(400, 404)],
      }).usable,
    ).toBe(false);
    expect(
      assessMeasurement({
        report: report({ id: 'a', lcp: 2000 }),
        runs: [{ ...run(400), fetchTime: 'same' }, { ...run(450), fetchTime: 'same' }],
      }).reasons.join(' '),
    ).toMatch(/cached report/);
    expect(
      assessMeasurement({
        report: report({ id: 'a', lcp: 2000 }),
        runs: [run(100), run(900)],
      }).reasons.join(' '),
    ).toMatch(/benchmark index ranges from 100 to 900/);
  });
});

describe('failing metric readout', () => {
  it('reads a CrUX percentile and scales an integer CLS', () => {
    const field = {
      loadingExperience: {
        metrics: {
          LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2400 },
          CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 10 },
        },
      },
    };
    expect(fieldP75(field, 'lcp')).toBe(2400);
    expect(fieldP75(field, 'cls')).toBe(0.1);
    expect(fieldP75(field, 'tbt' as MetricKey)).toBeUndefined();
  });

  it('says when CrUX is empty, and stays quiet on a passing metric', () => {
    const failing = report({ id: 'a', lcp: 3000, meets: false });
    expect(failingMetricReadout(failing, 'lcp')).toMatch(/p75 3000ms/);
    expect(failingMetricReadout(failing, 'lcp')).toMatch(/CrUX is empty/);
    const passing = report({ id: 'a', lcp: 2000, meets: true });
    expect(failingMetricReadout(passing, 'lcp')).toBeUndefined();
  });
});

describe('grep seeds', () => {
  it('keeps class names and file names an agent can search for', () => {
    expect(
      grepSeeds([
        {
          selector: 'section > img.hero-banner',
          url: 'https://static.guvi.in/zen/hero.png',
          snippet: '<img class="hero-banner card">',
        },
      ]),
    ).toEqual(['hero-banner', 'card', 'hero.png']);
  });
});

describe('cli flags', () => {
  it('parses list and compare without a url', () => {
    expect(parseArgs(['--list'])?.list).toBe(true);
    expect(parseArgs(['--compare', 'before-id', 'after-id', '--metric', 'lcp'])).toMatchObject({
      compare: ['before-id', 'after-id'],
      metric: ['lcp'],
    });
  });
});
