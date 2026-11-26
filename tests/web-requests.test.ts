/**
 * The Requests tab. Parity check: the request rows come out in the
 * order the CLI's --requests table prints.
 */
import { describe, expect, it } from 'vitest';
import { renderRequests } from '../src/rows.js';
import type { NetworkRequest } from '../src/types.js';
import {
  countOfType,
  DEFAULT_REQUESTS,
  requestRows,
  requestsFromParams,
  requestsToParams,
  requestTotals,
  type RequestFilters,
} from '../web/src/requests.js';

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
    expect(totals.byType[0]!.label).toBe('2 Scripts');
  });

  it('words each type as a count of things, and files untyped requests under Other', () => {
    expect(countOfType(40, 'Image')).toBe('40 Images');
    expect(countOfType(1, 'Image')).toBe('1 Image');
    expect(countOfType(2, 'Fetch')).toBe('2 Fetches');
    expect(countOfType(3, 'Other')).toBe('3 Other');
    const untyped: NetworkRequest[] = [
      { url: 'https://site.test/x', resourceType: '', transferSize: 100, party: 'first' },
      { url: 'https://site.test/y', resourceType: 'Other', transferSize: 50, party: 'first' },
      { url: 'https://site.test/z', resourceType: 'Image', transferSize: 900, party: 'first' },
    ] as NetworkRequest[];
    expect(requestTotals(untyped).byType.map((entry) => entry.label)).toEqual(['1 Image', '2 Other']);
  });

  it('round-trips through the URL', () => {
    const filters: RequestFilters = { party: 'third', sortBy: 'size', limit: 20 };
    expect(requestsFromParams(requestsToParams(filters))).toEqual(filters);
    expect(requestsFromParams(requestsToParams(DEFAULT_REQUESTS))).toEqual(DEFAULT_REQUESTS);
  });

  it('filters by one or more types, alongside party, order and limit', () => {
    const urls = (filters: RequestFilters) => requestRows(REQUESTS, filters).rows.map((row) => row.url.replace(/^https:\/\//, ''));
    expect(urls({ ...DEFAULT_REQUESTS, types: ['Script'] })).toEqual(['cdn.vendor.com/tag.js', 'site.test/app.js']);
    expect(urls({ ...DEFAULT_REQUESTS, types: ['Font', 'Stylesheet'] })).toEqual(['site.test/missing.css', 'fonts.vendor.com/f.woff2']);
    expect(urls({ party: 'third', sortBy: 'size', types: ['Script', 'Font'], limit: 1 })).toEqual(['cdn.vendor.com/tag.js']);
    expect(requestRows(REQUESTS, { ...DEFAULT_REQUESTS, types: ['Script'] }).matched).toBe(2);
    expect(requestRows(REQUESTS, { ...DEFAULT_REQUESTS, types: [] }).rows).toHaveLength(REQUESTS.length);
    expect(requestRows(REQUESTS, { ...DEFAULT_REQUESTS, types: ['Media'] }).rows).toEqual([]);
  });

  it('keeps the type filter in the page URL', () => {
    const filters: RequestFilters = { party: 'any', sortBy: 'start', types: ['Image', 'Font'] };
    expect(requestsToParams(filters).get('type')).toBe('Image,Font');
    expect(requestsFromParams(requestsToParams(filters))).toEqual(filters);
    expect(requestsFromParams(new URLSearchParams('type=')).types).toBeUndefined();
  });

  it('shows and filters a request Chrome left untyped as Other', () => {
    const untyped = [{ url: 'https://site.test/beacon', resourceType: '', transferSize: 0, party: 'first' }] as NetworkRequest[];
    expect(requestRows(untyped, DEFAULT_REQUESTS).rows[0]!.type).toBe('Other');
    expect(requestRows(untyped, { ...DEFAULT_REQUESTS, types: ['Other'] }).rows).toHaveLength(1);
  });
});
