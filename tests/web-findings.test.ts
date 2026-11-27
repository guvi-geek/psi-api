/**
 * The Findings tab's logic. The key check: for any filters, the server returns
 * the same findings, in the same order, as the CLI's own filterInsights.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { aggregateReports } from '../src/aggregate.js';
import { applyTargets } from '../src/targets.js';
import { saveReport } from '../src/storage.js';
import { buildServer } from '../src/server.js';
import { FileStore } from '../src/report-store.js';
import { filterInsights } from '../src/insights.js';
import { renderInsightRows } from '../src/rows.js';
import type { AggregatedReport } from '../src/types.js';
import {
  activeFilterCount,
  DEFAULT_FILTERS,
  filtersFromParams,
  filtersToApiQuery,
  filtersToParams,
  findingRow,
  insightFacts,
  insightRowsText,
  insightStats,
  parseDescription,
  type Filters,
} from '../web/src/findings.js';
import { makeReport } from './helpers.js';

const REPORT_ID = '2026-11-26T01-00-00Z-mobile';
let dir: string;
let app: FastifyInstance;
let report: AggregatedReport;
let previousDataDir: string | undefined;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'psi-api-findings-'));
  previousDataDir = process.env.PSI_DATA_DIR;
  process.env.PSI_DATA_DIR = dir;
  const runs = [0, 1, 2].map((i) => makeReport({ score: 60 + i, fetchTime: `f${i}` }));
  report = applyTargets(aggregateReports(runs, { reportId: REPORT_ID, runsRequested: 3 }));
  await saveReport(report, runs, dir);
  app = buildServer({ store: new FileStore() });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.PSI_DATA_DIR;
  else process.env.PSI_DATA_DIR = previousDataDir;
});

const CASES: Array<Partial<Filters>> = [
  {},
  { search: 'third party "cookies"' },
  { sortBy: 'score' },
  { party: 'first', noFlaky: true },
  { search: 'javascript', order: 'asc' },
  { party: 'third', sortBy: 'savingsBytes' },
  { sortBy: 'firstPartyShare' },
];

describe('the server filters like the CLI', () => {
  for (const partial of CASES) {
    it(`for ${JSON.stringify(partial)}`, async () => {
      const filters: Filters = { ...DEFAULT_FILTERS, ...partial };
      const response = await app.inject({
        method: 'GET',
        url: `/report/${REPORT_ID}/insights?${filtersToApiQuery(filters)}`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();

      // Same filters through the CLI's own filter call: same ids, same order.
      const cliIds = filterInsights(report.insights, {
        search: filters.search.trim() || undefined,
        party: filters.party,
        sortBy: filters.sortBy,
        order: filters.order,
        includeFlaky: !filters.noFlaky,
      }).map((insight) => insight.id);
      expect(body.insights.map((insight: { id: string }) => insight.id)).toEqual(cliIds);
    });
  }
});

describe('filters in the page URL', () => {
  it('round-trips every filter and keeps the URL short for defaults', () => {
    expect(filtersToParams(DEFAULT_FILTERS).toString()).toBe('');
    const filters: Filters = {
      ...DEFAULT_FILTERS,
      search: 'third party',
      party: 'first',
      sortBy: 'score',
      order: 'asc',
      noFlaky: true,
    };
    expect(filtersFromParams(filtersToParams(filters))).toEqual(filters);
    expect(activeFilterCount(filters)).toBe(3);
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0);
  });

  it('drops values the CLI would reject', () => {
    const filters = filtersFromParams(new URLSearchParams('party=all&sortBy=x&order=up'));
    expect(filters).toEqual(DEFAULT_FILTERS);
  });

});

describe('findingRow', () => {
  it('formats a row like the CLI table', () => {
    const insight = { ...report.insights[0]!, savingsMs: 559.4, savingsBytes: null, metricsAffected: ['lcp', 'fcp'], firstPartyShare: 1, appearedInRuns: 3, runsSucceeded: 3, flaky: false };
    expect(findingRow(insight)).toMatchObject({ saving: '559ms', affects: 'LCP FCP', ours: '100%', oursTone: 'good', seen: '3/3' });
    const bytesOnly = { ...insight, savingsMs: null, savingsBytes: 84 * 1024, firstPartyShare: 0.33 };
    expect(findingRow(bytesOnly)).toMatchObject({ saving: '84KB', ours: '33%', oursTone: 'warn' });
    const none = { ...insight, savingsMs: null, savingsBytes: null, firstPartyShare: null, metricsAffected: [] };
    expect(findingRow(none)).toMatchObject({ saving: '—', hasSaving: false, ours: '—', oursTone: 'none', affects: '—' });
  });
});

describe('one insight', () => {
  it('shows exactly the CLI --items text, without colour', () => {
    const withRows = report.insights.find((insight) => (insight.items?.length ?? 0) > 0)!;
    const text = insightRowsText(withRows, undefined, 100);
    expect(text).toBe(renderInsightRows(withRows, { width: 100, useColor: false, limit: 200 }).join('\n'));
    expect(text).not.toMatch(/\x1b\[/);
    expect(text.split('\n')[0]).toContain(withRows.id);
  });

  it('lists the JSON-only facts and per-run stats', () => {
    const insight = report.insights[0]!;
    const labels = insightFacts(insight).map((fact) => fact.label);
    expect(labels).toEqual(expect.arrayContaining(['Estimated saving', 'Score', 'Group', 'Seen in', 'Rows']));
    expect(insightStats(insight)[0]!.name).toBe('Score');
  });

  it('turns Lighthouse markdown into text, code and safe links only', () => {
    expect(parseDescription('Use `defer`. [Learn more](https://web.dev/x). [Bad](javascript:alert(1))')).toEqual([
      { text: 'Use ' },
      { code: 'defer' },
      { text: '. ' },
      { link: 'Learn more', href: 'https://web.dev/x' },
      { text: '. ' },
      { text: 'Bad' },
      { text: ')' },
    ]);
  });
});
