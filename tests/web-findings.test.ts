/**
 * The Findings tab's logic. The key check: for any filters, the CLI command the
 * page offers parses (with the CLI's own parser) to the same filters the server
 * reports it applied, so the page and the terminal show the same findings.
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
import { parseArgs } from '../src/cli.js';
import { filterInsights } from '../src/insights.js';
import { renderInsightRows } from '../src/rows.js';
import type { AggregatedReport } from '../src/types.js';
import {
  activeFilterCount,
  DEFAULT_FILTERS,
  filtersFromParams,
  filtersToApiQuery,
  filtersToCli,
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
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.PSI_DATA_DIR;
  else process.env.PSI_DATA_DIR = previousDataDir;
});

const FILTER_FIELDS = [
  'search',
  'id',
  'minSavingsMs',
  'minSavingsBytes',
  'maxScore',
  'minFirstPartyRatio',
  'hasItems',
  'party',
  'sortBy',
  'order',
  'limit',
  'includeFlaky',
] as const;

/** Splits a command line as a POSIX shell would for these args: spaces, "quotes", \" escapes. */
function shellSplit(line: string): string[] {
  const args: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (quoted && char === '\\' && line[i + 1] === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (char === ' ' && !quoted) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

const CASES: Array<Partial<Filters>> = [
  {},
  { search: 'third party "cookies"' },
  { maxScore: 0.9, sortBy: 'savingsMs' },
  { party: 'first', noFlaky: true },
  { search: 'javascript', order: 'asc', limit: 3 },
  { minSavingsMs: 100, minSavingsBytes: 2048, hasItems: true },
  { hasItems: false, party: 'third', sortBy: 'savingsBytes' },
  { minFirstPartyRatio: 0.5, sortBy: 'firstPartyShare', id: ['unused-javascript', 'render-blocking-resources'] },
];

describe('the CLI command and the server agree', () => {
  for (const partial of CASES) {
    it(`for ${JSON.stringify(partial)}`, async () => {
      const filters: Filters = { ...DEFAULT_FILTERS, ...partial };
      const response = await app.inject({
        method: 'GET',
        url: `/report/${REPORT_ID}/insights?${filtersToApiQuery(filters)}`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();

      const argv = shellSplit(filtersToCli(REPORT_ID, filters).replace(/^npm run psi -- /, ''));
      const cli = parseArgs(argv)!;
      for (const field of FILTER_FIELDS) {
        const fromCli = cli[field] === undefined || (Array.isArray(cli[field]) && cli[field].length === 0) ? undefined : cli[field];
        const fromServer = body.filters[field] === undefined || (Array.isArray(body.filters[field]) && body.filters[field].length === 0) ? undefined : body.filters[field];
        expect(fromServer, field).toEqual(fromCli);
      }

      // Same filters through the CLI's own filter call: same ids, same order.
      const cliIds = filterInsights(report.insights, {
        group: cli.group,
        minSavingsMs: cli.minSavingsMs,
        minSavingsBytes: cli.minSavingsBytes,
        maxScore: cli.maxScore,
        metric: cli.metric,
        search: cli.search,
        id: cli.id,
        hasItems: cli.hasItems,
        party: cli.party,
        minFirstPartyRatio: cli.minFirstPartyRatio,
        sortBy: cli.sortBy,
        order: cli.order,
        limit: cli.limit,
        includeFlaky: cli.includeFlaky,
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
      id: ['a', 'b'],
      minSavingsMs: 50,
      minSavingsBytes: 1000,
      maxScore: 0.5,
      minFirstPartyRatio: 0.25,
      hasItems: false,
      party: 'first',
      sortBy: 'score',
      order: 'asc',
      limit: 10,
      noFlaky: true,
    };
    expect(filtersFromParams(filtersToParams(filters))).toEqual(filters);
    expect(activeFilterCount(filters)).toBe(10);
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0);
  });

  it('drops values the CLI would reject', () => {
    const filters = filtersFromParams(new URLSearchParams('party=all&sortBy=x&maxScore=abc'));
    expect(filters.party).toBe('any');
    expect(filters.sortBy).toBe('savingsMs');
    expect(filters.maxScore).toBeUndefined();
  });

  it('drops numbers outside what the server accepts, instead of erroring', () => {
    const filters = filtersFromParams(
      new URLSearchParams('minFirstPartyRatio=2&maxScore=-0.1&limit=1.5&minSavingsMs=-5&minSavingsBytes=100'),
    );
    expect(filters.minFirstPartyRatio).toBeUndefined();
    expect(filters.maxScore).toBeUndefined();
    expect(filters.limit).toBeUndefined();
    expect(filters.minSavingsMs).toBeUndefined();
    expect(filters.minSavingsBytes).toBe(100);
    expect(filtersFromParams(new URLSearchParams('minFirstPartyRatio=1&maxScore=0&limit=0'))).toMatchObject({
      minFirstPartyRatio: 1,
      maxScore: 0,
      limit: 0,
    });
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
