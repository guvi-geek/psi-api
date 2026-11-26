/** The report Overview's logic: same values, bars and verdicts as the CLI. */
import { describe, expect, it } from 'vitest';
import { aggregateReports } from '../src/aggregate.js';
import { applyTargets } from '../src/targets.js';
import { passCount, targetBar } from '../src/render.js';
import type { AggregatedReport, NetworkRequest } from '../src/types.js';
import {
  cliCommand,
  fieldRows,
  metricRows,
  notFound,
  scoreSummary,
  spreadItems,
  statsTable,
  verdictSummary,
} from '../web/src/overview.js';
import { makeReport } from './helpers.js';

const TARGETS = {
  mobile: { score: 90, lcp: 2500, tbt: 200, cls: 0.1, fcp: 1800, speedIndex: 3400 },
  desktop: { score: 90, lcp: 1800, tbt: 150, cls: 0.1, fcp: 1200, speedIndex: 2400 },
};

/** Ten runs: LCP over budget on every run, TBT inside on the median but over on two runs. */
function report(): AggregatedReport {
  const tbt = [110, 118, 270, 86, 118, 116, 423, 122, 107.5, 117];
  const runs = tbt.map((value, i) =>
    makeReport({
      score: 80 + (i % 3),
      fetchTime: `t${i}`,
      metrics: { lcp: 3000 + i * 10, tbt: value, fcp: 1500, speedIndex: 3000, cls: 0.01 },
    }),
  );
  return applyTargets(aggregateReports(runs, { reportId: '2026-11-26T00-00-00Z-mobile', runsRequested: 10 }), TARGETS);
}

describe('verdictSummary', () => {
  it('uses the CLI rule and names failures worst first, with runs in target', () => {
    const r = report();
    const verdict = verdictSummary(r);
    const failing = r.targets.gaps.filter((gap) => !gap.meets);
    expect(verdict.failing).toBe(failing.length);
    expect(verdict.total).toBe(r.targets.gaps.length);
    expect(verdict.word).toBe(failing.length > r.targets.gaps.length / 2 ? 'FAIL' : 'PASS');
    // LCP misses by ~20% of budget, the score by ~10%: LCP is named first.
    expect(verdict.named[0]!.metric).toBe('lcp');
    expect(verdict.named[0]!.text).toMatch(/^LCP \d+ms vs 2500ms \(0\/10 runs in target\)$/);
    expect(verdict.named.map((entry) => entry.metric)).toContain('tbt');
  });

  it('flags the tail-only failure: TBT median inside budget, 2 of 10 runs over', () => {
    const r = report();
    const tbt = r.targets.gaps.find((gap) => gap.metric === 'tbt')!;
    expect(tbt.delta).toBeLessThan(0);
    expect(tbt.meets).toBe(false);
    const row = metricRows(r).find((entry) => entry.key === 'tbt')!;
    expect(row.verdict).toBe('in target');
    expect(row.over).toBe(false);
    expect(row.runsInTarget).toBe('8/10');
    // Median in target but the tail fails: amber, as the CLI colours it.
    expect(row.severity).toBe('warn');
  });
});

describe('metricRows', () => {
  it('returns the CLI rows in order with its values, percent and bar', () => {
    const r = report();
    const rows = metricRows(r);
    expect(rows.map((row) => row.short)).toEqual(['FCP', 'LCP', 'SI', 'TBT', 'CLS']);
    const lcp = rows.find((row) => row.key === 'lcp')!;
    const gap = r.targets.gaps.find((entry) => entry.metric === 'lcp')!;
    const bar = targetBar(gap.actual, gap.target);
    expect(lcp.value).toBe(`${Math.round(gap.actual)}ms`);
    expect(lcp.target).toBe('2500ms');
    expect(lcp.verdict).toBe(`+${Math.round(gap.delta)}ms over`);
    expect(lcp.percent).toBe(`${Math.round(bar.used * 100)}%`);
    expect(lcp.bar).toEqual({ fillPercent: (bar.used / 2) * 100, over: true });
    expect(lcp.runsInTarget).toBe(passCount(gap));
    expect(lcp.severity).toBe('bad');
    expect(lcp.values).toHaveLength(10);
    expect(lcp.spread.map((item) => item.label)).toEqual(['p25', 'p75', 'p95', 'Range', 'Stddev']);
  });

  it('prints CLS as a unitless score and clamps the bar at 200% of target', () => {
    const rows = metricRows(report());
    const cls = rows.find((row) => row.key === 'cls')!;
    expect(cls.value).toBe('0.010');
    expect(cls.target).toBe('0.100');
    expect(cls.bar.fillPercent).toBeCloseTo(5);
    const huge = applyTargets(
      aggregateReports([makeReport({ metrics: { lcp: 99_000 }, fetchTime: 'x' })], { reportId: 'r', runsRequested: 1 }),
      TARGETS,
    );
    expect(metricRows(huge).find((row) => row.key === 'lcp')!.bar.fillPercent).toBe(100);
  });
});

describe('scoreSummary and spread', () => {
  it('rounds the score, uses Lighthouse bands and keeps the target', () => {
    const summary = scoreSummary(report());
    expect(summary.value).toBe(81);
    expect(summary.severity).toBe('warn');
    expect(summary.target).toBe(90);
    expect(summary.values).toHaveLength(10);
    expect(summary.spread.find((item) => item.label === 'Range')!.value).toBe('80–82');
  });

  it('returns nothing for a metric without stats', () => {
    expect(spreadItems(undefined, 'lcp')).toEqual([]);
  });
});

describe('notFound', () => {
  const request = (url: string, statusCode: number, resourceType = 'Script') =>
    ({ url, statusCode, resourceType }) as NetworkRequest;

  it('separates a missing page from missing files', () => {
    const r = report();
    r.url = 'https://example.com/a';
    r.finalUrl = 'https://example.com/a';
    r.requests = [
      request('https://example.com/a', 404, 'Document'),
      request('https://example.com/app.js', 404),
      request('https://example.com/ok.css', 200, 'Stylesheet'),
    ];
    expect(notFound(r)).toEqual({ pageUrl: 'https://example.com/a', files: ['https://example.com/app.js'] });
  });

  it('is empty when nothing returned 404 or there are no requests', () => {
    const r = report();
    r.requests = [request('https://example.com/', 200, 'Document')];
    expect(notFound(r)).toEqual({ files: [] });
    r.requests = null;
    expect(notFound(r)).toEqual({ files: [] });
  });
});

describe('fieldRows', () => {
  it('is null when CrUX has no data for the page, which is normal on staging', () => {
    const r = report();
    r.fieldData = null;
    expect(fieldRows(r)).toBeNull();
    r.fieldData = { loadingExperience: {} };
    expect(fieldRows(r)).toBeNull();
  });

  it('reads the p75 values, and CLS given in hundredths', () => {
    const r = report();
    r.fieldData = {
      loadingExperience: {
        metrics: {
          LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2900 },
          CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 5 },
        },
      },
    };
    const rows = fieldRows(r)!;
    expect(rows.find((row) => row.key === 'lcp')!.value).toBe('2900ms');
    expect(rows.find((row) => row.key === 'cls')!.value).toBe('0.050');
    expect(rows.find((row) => row.key === 'inp')!.value).toBe('Not in CrUX');
  });
});

describe('statsTable and cliCommand', () => {
  it('shows the score and each metric under mean, median and mode', () => {
    const r = report();
    const table = statsTable(r);
    expect(table[0]).toMatchObject({ key: 'score', median: String(r.stats.median.score) });
    expect(table.map((row) => row.key)).toEqual(['score', 'fcp', 'lcp', 'speedIndex', 'tbt', 'cls']);
  });

  it('gives the free re-read command', () => {
    expect(cliCommand('2026-11-26T00-00-00Z-mobile')).toBe('npm run psi -- --reportId 2026-11-26T00-00-00Z-mobile');
  });
});
