/**
 * The Work queue, Requests and JSON tabs. Parity checks: the --diagnose
 * command the page offers ranks the same findings as the server, and the
 * request rows come out in the order the CLI's --requests table prints.
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
import { diagnose } from '../src/diagnose.js';
import { renderRequests } from '../src/rows.js';
import type { AggregatedReport, Gap, NetworkRequest } from '../src/types.js';
import {
  DEFAULT_QUEUE,
  DEFAULT_REQUESTS,
  gapRow,
  imageRow,
  jsonSections,
  lcpView,
  queueFromParams,
  queueRow,
  queueToApiQuery,
  queueToCli,
  queueToParams,
  requestRows,
  requestsFromParams,
  requestsToCli,
  requestsToParams,
  requestTotals,
  unreliableText,
  type RequestFilters,
  type WorkQueueFilters,
} from '../web/src/workqueue.js';
import { normalizeLh13 } from './helpers.js';

const REPORT_ID = '2026-11-26T02-00-00Z-mobile';
let dir: string;
let app: FastifyInstance;
let report: AggregatedReport;
let previousDataDir: string | undefined;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'psi-api-workqueue-'));
  previousDataDir = process.env.PSI_DATA_DIR;
  process.env.PSI_DATA_DIR = dir;
  const runs = [0, 1, 2].map((i) =>
    normalizeLh13((raw) => {
      (raw as { lighthouseResult: { fetchTime: string } }).lighthouseResult.fetchTime = `2026-01-01T00:00:0${i}.000Z`;
    }),
  );
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

const QUEUE_CASES: Array<Partial<WorkQueueFilters>> = [
  {},
  { party: 'first' },
  { party: 'third', sortBy: 'savingsBytes' },
  { minFirstPartyRatio: 0.5, limit: 2 },
  { noFlaky: true, sortBy: 'firstPartyShare' },
];

describe('the --diagnose command and the server rank the same work', () => {
  for (const partial of QUEUE_CASES) {
    it(`for ${JSON.stringify(partial)}`, async () => {
      const filters: WorkQueueFilters = { ...DEFAULT_QUEUE, ...partial };
      const body = (
        await app.inject({ method: 'GET', url: `/report/${REPORT_ID}/diagnosis?${queueToApiQuery(filters)}` })
      ).json();

      const argv = queueToCli(REPORT_ID, filters).replace(/^npm run psi -- /, '').split(' ');
      const cli = parseArgs(argv)!;
      expect(cli.diagnose).toBe(true);
      // The filters renderDiagnosis passes, from the CLI's own parsed flags.
      const fromCli = diagnose(report, {
        filters: {
          party: cli.party,
          minFirstPartyRatio: cli.minFirstPartyRatio,
          sortBy: cli.sortBy,
          limit: cli.limit,
          includeFlaky: cli.includeFlaky,
        },
      });
      expect(body.ranked.map((entry: { insight: { id: string } }) => entry.insight.id)).toEqual(
        fromCli.ranked.map((entry) => entry.insight.id),
      );
      expect(body.priorityOrder.map((gap: Gap) => gap.metric)).toEqual(fromCli.priorityOrder.map((gap) => gap.metric));
      expect(body.cautions).toEqual(fromCli.cautions);
      expect(body.exhausted).toBe(fromCli.exhausted);
    });
  }

  it('round-trips the queue filters through the page URL', () => {
    const filters: WorkQueueFilters = { party: 'first', minFirstPartyRatio: 0.25, sortBy: 'score', limit: 5, noFlaky: true };
    expect(queueFromParams(queueToParams(filters))).toEqual(filters);
    expect(queueToParams(DEFAULT_QUEUE).toString()).toBe('');
    expect(queueFromParams(new URLSearchParams('party=all&minFirstPartyRatio=2&limit=-1'))).toEqual(DEFAULT_QUEUE);
  });
});

describe('work queue rows', () => {
  it('formats each ranked finding like the CLI queue', () => {
    const diagnosis = diagnose(report);
    expect(diagnosis.ranked.length).toBeGreaterThan(0);
    const row = queueRow(diagnosis.ranked[0]!);
    expect(row.rank).toBe(1);
    expect(row.reason.length).toBeGreaterThan(0);
    const unknown = queueRow({ ...diagnosis.ranked[0]!, firstPartyShare: null });
    expect(unknown).toMatchObject({ ours: 'unknown', oursTone: 'dim' });
    const mixed = queueRow({ ...diagnosis.ranked[0]!, firstPartyShare: 0.4 });
    expect(mixed).toMatchObject({ ours: '40%', oursTone: 'warn' });
  });

  it('shows a failing target with the CLI value, verdict and runs', () => {
    const gap: Gap = { metric: 'lcp', actual: 3151, target: 2500, delta: 651, meets: false, passRate: 0.1, runsMeasured: 10, overBudgetRuns: 9 };
    expect(gapRow(gap)).toMatchObject({
      name: 'Largest contentful paint (LCP)',
      value: '3151ms',
      target: '2500ms',
      verdict: '+651ms over',
      over: true,
      runsInTarget: '1/10',
      severity: 'bad',
    });
    const tail: Gap = { ...gap, actual: 2400, delta: -100, passRate: 0.8, overBudgetRuns: 2 };
    expect(unreliableText({ unreliable: [tail] })[0]).toBe('LCP: median 2400ms is inside 2500ms, but only 8/10 runs are');
  });

  it('keeps LCP phases in timeline order with their shares', () => {
    const view = lcpView({
      isText: false,
      elementType: 'IMG',
      text: 'Hero',
      phases: { ttfb: 600, loadDelay: 100, loadTime: 900, renderDelay: 400 },
      bottleneck: 'resource',
    })!;
    expect(view).toMatchObject({ kind: 'image', tag: 'img', totalMs: 2000, label: { text: 'Hero', isAlt: true } });
    expect(view.phases.map((phase) => phase.key)).toEqual(['ttfb', 'loadDelay', 'loadTime', 'renderDelay']);
    expect(view.phases[2]!.share).toBeCloseTo(0.45);
    expect(lcpView(null)).toBeNull();
    expect(lcpView(report.lcp)).not.toBeNull();
  });

  it('marks an oversized image the pixel correction clears as fine', () => {
    expect(imageRow({ kind: 'oversized', real: false, url: 'https://a/x.png', detail: 'd', bytes: 2048 })).toMatchObject({
      label: 'Fine',
      fine: true,
      size: '2KB',
    });
    expect(imageRow({ kind: 'lazyInFirstFold', selector: 'img.hero', detail: 'd' })).toMatchObject({
      label: 'Lazy in first fold',
      fine: false,
      where: 'img.hero',
    });
  });
});

const REQUESTS: NetworkRequest[] = [
  { url: 'https://site.test/', resourceType: 'Document', priority: 'VeryHigh', startMs: 0, endMs: 120, transferSize: 18_000, statusCode: 200, party: 'first' },
  { url: 'https://cdn.vendor.com/tag.js', resourceType: 'Script', priority: 'Low', startMs: 300, endMs: 900, transferSize: 95_000, statusCode: 200, party: 'third', entity: 'Vendor' },
  { url: 'https://site.test/app.js', resourceType: 'Script', priority: 'High', startMs: 140, endMs: 400, transferSize: 210_000, resourceSize: 700_000, statusCode: 200, party: 'first', isLinkPreload: true },
  { url: 'https://site.test/missing.css', resourceType: 'Stylesheet', priority: 'VeryHigh', startMs: 150, endMs: 160, transferSize: 400, statusCode: 404, party: 'first' },
  { url: 'https://fonts.vendor.com/f.woff2', resourceType: 'Font', startMs: 500, transferSize: 30_000, party: 'third' },
];

/** The URL column of renderRequests, in print order. */
function cliUrls(filters: RequestFilters): string[] {
  const lines = renderRequests(REQUESTS, { width: 400, useColor: false, party: filters.party, sortBy: filters.sortBy, limit: filters.limit });
  return lines
    .map((line) => /(?:preload )?((?:site|cdn|fonts)\.[^\s]+)/.exec(line)?.[1])
    .filter((url): url is string => Boolean(url) && !url!.endsWith(','));
}

describe('requests', () => {
  const CASES: RequestFilters[] = [
    DEFAULT_REQUESTS,
    { party: 'any', sortBy: 'size' },
    { party: 'first', sortBy: 'start' },
    { party: 'third', sortBy: 'size', limit: 1 },
    { party: 'any', sortBy: 'size', limit: 3 },
  ];
  for (const filters of CASES) {
    it(`prints the CLI rows in the CLI order for ${JSON.stringify(filters)}`, () => {
      const { rows } = requestRows(REQUESTS, filters);
      expect(rows.map((row) => row.url.replace(/^https?:\/\//, ''))).toEqual(cliUrls(filters));
    });
  }

  it('counts what a limit hides, and flags 404s and preloads', () => {
    const { rows, matched } = requestRows(REQUESTS, { party: 'any', sortBy: 'size', limit: 2 });
    expect(matched).toBe(5);
    expect(rows.map((row) => row.size)).toEqual(['205KB', '93KB']);
    const all = requestRows(REQUESTS, DEFAULT_REQUESTS).rows;
    expect(all.find((row) => row.url.endsWith('missing.css'))).toMatchObject({ notFound: true, status: '404' });
    expect(all.find((row) => row.url.endsWith('app.js'))).toMatchObject({ preload: true, resourceSize: '684KB' });
    expect(all.find((row) => row.url.endsWith('f.woff2'))).toMatchObject({ end: '—', priority: '—', status: '—' });
    expect(requestRows(null, DEFAULT_REQUESTS)).toEqual({ rows: [], matched: 0 });
  });

  it('sums the totals the CLI summary line prints', () => {
    const totals = requestTotals(REQUESTS);
    expect(totals).toMatchObject({ count: 5, first: { count: 3 }, third: { count: 2 }, notFound: 1 });
    const summary = renderRequests(REQUESTS, { width: 400, useColor: false })[0]!;
    expect(summary).toContain(`${totals.count} requests · ${totals.bytes} transferred`);
    expect(summary).toContain(`first party ${totals.first.count} (${totals.first.bytes})`);
    expect(summary).toContain(`third party ${totals.third.count} (${totals.third.bytes})`);
    expect(totals.byType[0]!.type).toBe('Script');
  });

  it('round-trips through the URL and builds the --requests command', () => {
    const filters: RequestFilters = { party: 'third', sortBy: 'size', limit: 20 };
    expect(requestsFromParams(requestsToParams(filters))).toEqual(filters);
    expect(requestsToCli('id', filters)).toBe('npm run psi -- --reportId id --requests size --party third --limit 20');
    expect(requestsToCli('id', DEFAULT_REQUESTS)).toBe('npm run psi -- --reportId id --requests');
    const parsed = parseArgs(requestsToCli('id', filters).replace(/^npm run psi -- /, '').split(' '))!;
    expect(parsed).toMatchObject({ requests: 'size', party: 'third', limit: 20 });
  });
});

describe('json sections', () => {
  it('lists every top-level key with its size', () => {
    const sections = jsonSections(report);
    expect(sections.map((section) => section.key)).toEqual(Object.keys(report));
    expect(sections.every((section) => section.bytes > 0)).toBe(true);
  });
});
