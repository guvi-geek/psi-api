/**
 * The Requests and JSON tabs. Parity check: the request rows come out in the
 * order the CLI's --requests table prints.
 */
import { describe, expect, it } from 'vitest';
import { aggregateReports } from '../src/aggregate.js';
import { applyTargets } from '../src/targets.js';
import { parseArgs } from '../src/cli.js';
import { renderRequests } from '../src/rows.js';
import type { NetworkRequest } from '../src/types.js';
import {
  DEFAULT_REQUESTS,
  jsonSections,
  requestRows,
  requestsFromParams,
  requestsToCli,
  requestsToParams,
  requestTotals,
  type RequestFilters,
} from '../web/src/requests.js';
import { normalizeLh13 } from './helpers.js';

const report = applyTargets(
  aggregateReports(
    [0, 1, 2].map((i) =>
      normalizeLh13((raw) => {
        (raw as { lighthouseResult: { fetchTime: string } }).lighthouseResult.fetchTime = `2026-01-01T00:00:0${i}.000Z`;
      }),
    ),
    { reportId: '2026-11-26T02-00-00Z-mobile', runsRequested: 3 },
  ),
);

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
