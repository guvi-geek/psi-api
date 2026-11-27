/** GET /report/:reportId/categories: the other categories a report's runs read, for free. */
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { FileStore } from '../src/report-store.js';
import { aggregateReports } from '../src/aggregate.js';
import { applyTargets } from '../src/targets.js';
import { saveReport } from '../src/storage.js';
import { makeReport } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ALL = JSON.parse(readFileSync(path.join(here, 'fixtures', 'raw-all-categories-real.json'), 'utf8'));
const OLD_ID = '2026-11-20T10-00-00Z-mobile';
let dir: string;
let app: FastifyInstance;
let previous: Record<string, string | undefined>;
let calls = 0;
const asked: string[][] = [];

const fetchImpl = (async (input: string | URL) => {
  asked.push(new URL(String(input)).searchParams.getAll('category'));
  const raw = JSON.parse(JSON.stringify(ALL));
  raw.lighthouseResult.fetchTime = `2026-11-27T11:00:0${calls++}.000Z`;
  return new Response(JSON.stringify(raw), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'psi-api-server-categories-'));
  previous = { PSI_DATA_DIR: process.env.PSI_DATA_DIR, PSI_API_KEY: process.env.PSI_API_KEY };
  process.env.PSI_DATA_DIR = dir;
  process.env.PSI_API_KEY = 'test-key';
  // A report saved before runs read every category: no categories.json beside it.
  const runs = [0, 1].map((i) => makeReport({ fetchTime: `o${i}` }));
  await saveReport(applyTargets(aggregateReports(runs, { reportId: OLD_ID, runsRequested: 2 })), runs, dir);
  app = buildServer({ store: new FileStore(), fetchImpl, sleepImpl: async () => {} });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('GET /report/:reportId/categories', () => {
  it('returns the categories a measurement read, with no further PSI call', async () => {
    const measured = await app.inject({ method: 'POST', url: '/report', payload: { url: 'https://www.guvi.in/zen-class/', runs: 2 } });
    expect(measured.statusCode).toBe(200);
    const reportId = measured.json().reportId as string;
    expect(asked).toHaveLength(2);
    expect(asked[0]).toEqual(['PERFORMANCE', 'ACCESSIBILITY', 'BEST_PRACTICES', 'SEO', 'AGENTIC_BROWSING']);

    const response = await app.inject({ method: 'GET', url: `/report/${reportId}/categories` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.reportId).toBe(reportId);
    expect(Object.keys(body.categories)).toEqual(['accessibility', 'best-practices', 'seo', 'agentic-browsing']);
    expect(body.categories.accessibility).toMatchObject({ title: 'Accessibility', score: 97 });
    expect(asked).toHaveLength(2);

    // The report itself is unchanged: it scores performance only.
    const report = (await app.inject({ method: 'GET', url: `/report/${reportId}` })).json();
    expect(report.environment.categories).toEqual(['performance']);
    expect(report).not.toHaveProperty('categories');
  });

  it('says null for a report measured before runs read every category', async () => {
    const response = await app.inject({ method: 'GET', url: `/report/${OLD_ID}/categories` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ reportId: OLD_ID, categories: null });
  });

  it('404s for an unknown report, as GET /report/:reportId does', async () => {
    const response = await app.inject({ method: 'GET', url: '/report/2020-01-01T00-00-00Z-mobile/categories' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });
});
