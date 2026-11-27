/**
 * The web UI's reports in MongoDB, against the real dev server (through the VPN
 * or the cloudflared tunnel). Skipped when MONGODB_URI is not set.
 *
 * It writes to the PSI-API-test database, never PSI-API. GUVI bans deletes, so
 * nothing is cleaned up: every test uses report ids no other run can repeat,
 * and the test database grows by a few small documents each run.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { aggregateReports } from '../src/aggregate.js';
import { applyTargets } from '../src/targets.js';
import { closeMongo, connectMongo, count, getDBName } from '../src/db/mongo.js';
import { COLLECTIONS, MongoStore } from '../src/db/mongo-store.js';
import { buildServer } from '../src/server.js';
import { makeReport } from './helpers.js';
import type { AggregatedReport, NormalizedReport } from '../src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ALL = JSON.parse(readFileSync(path.join(here, 'fixtures', 'raw-all-categories-real.json'), 'utf8'));
const hasMongo = Boolean(process.env.MONGODB_URI);

/** A report id no earlier run used: this run's start plus a counter, in seconds. */
const started = Date.now();
let nextId = 0;
function freshId(strategy: 'mobile' | 'desktop' = 'mobile'): string {
  const date = new Date(started + (nextId += 1) * 1000 + Math.floor(Math.random() * 1000) * 60_000);
  return `${date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-')}-${strategy}`;
}

function storedReport(reportId: string): { report: AggregatedReport; runs: NormalizedReport[] } {
  const runs = [50, 60, 55].map((score, i) => makeReport({ score, fetchTime: `${reportId}-${i}` }));
  return { report: applyTargets(aggregateReports(runs, { reportId, runsRequested: 3 })), runs };
}

describe.skipIf(!hasMongo)('MongoStore on the dev MongoDB', () => {
  const store = new MongoStore();
  let previousDb: string | undefined;

  beforeAll(async () => {
    previousDb = process.env.PSI_MONGO_DB;
    process.env.PSI_MONGO_DB = 'PSI-API-test';
    await connectMongo();
  });

  afterAll(async () => {
    await closeMongo();
    if (previousDb === undefined) delete process.env.PSI_MONGO_DB;
    else process.env.PSI_MONGO_DB = previousDb;
  });

  it('writes to the test database only', () => {
    expect(getDBName()).toBe('PSI-API-test');
  });

  it('reads back exactly the report, runs and categories it saved', async () => {
    const reportId = freshId();
    const { report, runs } = storedReport(reportId);
    const saved = await store.saveReport(report, runs);
    expect(saved).toEqual({ reportId, location: 'mongodb PSI-API-test.reports' });

    // Exactly what the file store would give back: the JSON of what was saved.
    expect(await store.loadReport(reportId)).toEqual(JSON.parse(JSON.stringify(report)));
    expect(await store.loadRuns(reportId)).toEqual(JSON.parse(JSON.stringify(runs)));
    expect(await count(getDBName(), COLLECTIONS.runs, { reportId })).toBe(3);

    expect(await store.loadCategories(reportId)).toBeNull();
    await store.saveCategories(report, { seo: { title: 'SEO', score: 92 } as never });
    expect(await store.loadCategories(reportId)).toEqual({ seo: { title: 'SEO', score: 92 } });
  });

  it('lists every report newest first, with the sidebar fields', async () => {
    const older = freshId();
    const newer = freshId('desktop');
    for (const id of [older, newer]) {
      const { report, runs } = storedReport(id);
      await store.saveReport(report, runs);
    }
    const summaries = await store.listSummaries();
    const ids = summaries.map((summary) => summary.reportId);
    expect(ids.indexOf(newer)).toBeGreaterThanOrEqual(0);
    expect(ids).toEqual([...ids].sort().reverse());
    expect(summaries.find((summary) => summary.reportId === older)).toMatchObject({
      reportId: older,
      host: 'example.com',
      strategy: 'mobile',
      score: 55,
      runsRequested: 3,
      runsSucceeded: 3,
    });
  });

  it('rewrites a report on update and leaves its runs alone', async () => {
    const reportId = freshId();
    const { report, runs } = storedReport(reportId);
    await store.saveReport(report, runs);
    await store.updateReport({ ...report, stat: 'mean' });
    expect((await store.loadReport(reportId))?.stat).toBe('mean');
    expect(await store.loadRuns(reportId)).toHaveLength(3);
    await expect(store.updateReport({ ...report, reportId: freshId() })).rejects.toThrow(/no stored report/);
  });

  it('returns null for a report it does not hold or an id that cannot exist, and refuses to write one', async () => {
    expect(await store.loadReport(freshId())).toBeNull();
    expect(await store.loadRuns(freshId())).toBeNull();
    expect(await store.loadReport('{"$ne": null}')).toBeNull();
    expect(await store.loadCategories('abc def')).toBeNull();
    const { report, runs } = storedReport(freshId());
    await expect(store.saveReport({ ...report, reportId: '../x' }, runs)).rejects.toThrow(/invalid reportId/);
  });

  describe('the UI server on MongoDB', () => {
    let app: FastifyInstance;
    let calls = 0;
    const fetchImpl = (async () => {
      const raw = JSON.parse(JSON.stringify(ALL));
      raw.lighthouseResult.fetchTime = new Date(started + (calls += 1) * 1000).toISOString();
      return new Response(JSON.stringify(raw), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    beforeAll(async () => {
      process.env.PSI_API_KEY ??= 'test-key';
      app = buildServer({ store, fetchImpl, sleepImpl: async () => {} });
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it('measures, lists, reads, shows categories and reanalyzes, all from MongoDB', async () => {
      const measured = await app.inject({
        method: 'POST',
        url: '/report',
        payload: { url: `https://www.guvi.in/zen-class/?t=${started}`, runs: 2, force: true },
      });
      expect(measured.statusCode).toBe(200);
      const reportId = measured.json().reportId as string;
      expect(await count(getDBName(), COLLECTIONS.reports, { reportId })).toBe(1);
      expect(await count(getDBName(), COLLECTIONS.runs, { reportId })).toBe(2);
      expect(await count(getDBName(), COLLECTIONS.categories, { reportId })).toBe(1);

      const list = (await app.inject({ method: 'GET', url: '/reports' })).json();
      expect(list.reports.find((row: { reportId: string }) => row.reportId === reportId)).toMatchObject({ host: 'www.guvi.in' });

      expect((await app.inject({ method: 'GET', url: `/report/${reportId}` })).json().reportId).toBe(reportId);
      const categories = (await app.inject({ method: 'GET', url: `/report/${reportId}/categories` })).json();
      expect(categories.categories.accessibility).toMatchObject({ title: 'Accessibility', score: 97 });
      expect((await app.inject({ method: 'GET', url: `/report/${reportId}/diagnosis` })).statusCode).toBe(200);

      const reanalyzed = await app.inject({ method: 'POST', url: '/reanalyze', payload: { reportId, save: true } });
      expect(reanalyzed.statusCode).toBe(200);
      expect(reanalyzed.json().reanalyzed[0]).toMatchObject({ reportId, saved: true });
      expect(await count(getDBName(), COLLECTIONS.runs, { reportId })).toBe(2);
    });
  });
});
