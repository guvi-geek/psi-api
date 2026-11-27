/**
 * The report list a page at a time (#3): GET /reports and the store's list
 * options, and the server's check that MongoDB has the indexes the list needs.
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
import { FileStore, matchesList } from '../src/report-store.js';
import { missingIndexes, REQUIRED_INDEXES } from '../src/db/mongo-store.js';
import { reportsPath } from '../web/src/run.js';
import { makeReport } from './helpers.js';

// Seven reports, one a minute, on two pages of one site and one of another.
const IDS = Array.from({ length: 7 }, (_, i) => `2026-11-27T10-0${i}-00Z-mobile-00000${i}`);
const urlOf = (i: number) => (i === 3 ? 'https://other.test/' : i % 2 ? 'https://site.test/a' : 'https://site.test/b');
let dir: string;
let app: FastifyInstance;
let previous: string | undefined;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'psi-api-report-list-'));
  previous = process.env.PSI_DATA_DIR;
  process.env.PSI_DATA_DIR = dir;
  for (const [i, reportId] of IDS.entries()) {
    const runs = [makeReport({ fetchTime: `f${i}`, url: urlOf(i) })];
    const report = applyTargets(aggregateReports(runs, { reportId, runsRequested: 1 }));
    await saveReport({ ...report, url: urlOf(i) }, runs, dir);
  }
  app = buildServer({ store: new FileStore() });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
  if (previous === undefined) delete process.env.PSI_DATA_DIR;
  else process.env.PSI_DATA_DIR = previous;
});

const newestFirst = [...IDS].reverse();
const ids = (body: { reports: Array<{ reportId: string }> }) => body.reports.map((report) => report.reportId);

describe('GET /reports, a page at a time', () => {
  it('returns one page and a cursor for the next', async () => {
    const first = (await app.inject({ method: 'GET', url: '/reports?limit=3' })).json();
    expect(ids(first)).toEqual(newestFirst.slice(0, 3));
    expect(first.next).toBe(newestFirst[2]);

    const second = (await app.inject({ method: 'GET', url: `/reports?limit=3&before=${first.next}` })).json();
    expect(ids(second)).toEqual(newestFirst.slice(3, 6));

    const last = (await app.inject({ method: 'GET', url: `/reports?limit=3&before=${second.next}` })).json();
    expect(ids(last)).toEqual(newestFirst.slice(6));
    expect(last.next).toBeNull();
  });

  it('pages 50 at a time by default, and has no next page when all fit', async () => {
    const body = (await app.inject({ method: 'GET', url: '/reports' })).json();
    expect(ids(body)).toEqual(newestFirst);
    expect(body.next).toBeNull();
  });

  it('filters by page address on the server, ignoring case', async () => {
    const body = (await app.inject({ method: 'GET', url: '/reports?q=OTHER.test' })).json();
    expect(ids(body)).toEqual([IDS[3]]);
    const paged = (await app.inject({ method: 'GET', url: '/reports?q=site.test/a&limit=1' })).json();
    expect(paged.reports.every((report: { url: string }) => report.url === 'https://site.test/a')).toBe(true);
    expect(paged.next).not.toBeNull();
  });

  it('refuses a limit out of range', async () => {
    expect((await app.inject({ method: 'GET', url: '/reports?limit=0' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/reports?limit=500' })).statusCode).toBe(400);
  });

  it('lists every report when asked without options, as the CLI and the sweep use it', async () => {
    expect((await new FileStore(dir).listSummaries()).map((summary) => summary.reportId)).toEqual(newestFirst);
    expect(matchesList({ reportId: 'b', url: 'https://x.test/A' }, { before: 'c', q: 'x.test/a' })).toBe(true);
    expect(matchesList({ reportId: 'c', url: 'https://x.test/' }, { before: 'c' })).toBe(false);
  });
});

describe('the sidebar asks for one page', () => {
  it('builds the request path', () => {
    expect(reportsPath()).toBe('/reports?limit=50');
    expect(reportsPath({ q: 'zen class', before: IDS[2] })).toBe(`/reports?limit=50&before=${IDS[2]}&q=zen+class`);
  });
});

describe('the MongoDB index check', () => {
  const all = {
    reports: [{ key: { _id: 1 } }, { key: { reportId: 1 }, unique: true }],
    runs: [{ key: { reportId: 1, index: 1 }, unique: true }],
    categories: [{ key: { reportId: 1 }, unique: true }],
  };

  it('passes when every unique index the list and the ids need is there', () => {
    expect(missingIndexes(all)).toEqual([]);
    expect(REQUIRED_INDEXES).toHaveLength(3);
  });

  it('names each missing or non-unique one', () => {
    expect(missingIndexes({ ...all, runs: [] })).toEqual(['runs {"reportId":1,"index":1} (unique)']);
    expect(missingIndexes({ ...all, reports: [{ key: { reportId: 1 } }] })).toEqual(['reports {"reportId":1} (unique)']);
    expect(missingIndexes({})).toHaveLength(3);
  });
});
