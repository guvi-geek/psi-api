/**
 * The routes the web UI needs on top of the original API: the CLI's --list,
 * --reanalyze and --no-save, plus live job progress. Each must give
 * the same answer the CLI gives, because both read the same library code.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { aggregateReports } from '../src/aggregate.js';
import { applyTargets, loadTargets } from '../src/targets.js';
import { listReports, loadReport, saveReport } from '../src/storage.js';
import { buildServer } from '../src/server.js';
import { fakeResponse, fixtureRaw, makeReport } from './helpers.js';

const BEFORE_ID = '2026-09-29T10-30-00Z-mobile';
const AFTER_ID = '2026-09-30T10-30-00Z-mobile';

let dir: string;
let app: FastifyInstance;
let previousDataDir: string | undefined;

/** A PSI stand-in: every call is a fresh analysis (unique fetchTime), score 80. */
function fakePsi() {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    const raw = JSON.parse(JSON.stringify(fixtureRaw)) as {
      lighthouseResult: { categories: { performance: { score: number } }; fetchTime: string };
    };
    raw.lighthouseResult.categories.performance.score = 0.8;
    raw.lighthouseResult.fetchTime = `2026-01-01T00:00:${String(calls).padStart(2, '0')}.000Z`;
    return fakeResponse(raw);
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

async function waitForJob(server: FastifyInstance, jobId: string) {
  for (let i = 0; i < 200; i += 1) {
    const job = (await server.inject({ method: 'GET', url: `/jobs/${jobId}` })).json();
    if (job.status === 'done' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('job did not finish');
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'psi-api-server-ui-'));
  previousDataDir = process.env.PSI_DATA_DIR;
  process.env.PSI_DATA_DIR = dir;

  const beforeRuns = [
    makeReport({ score: 50, fetchTime: 'a', metrics: { lcp: 3400 } }),
    makeReport({ score: 52, fetchTime: 'b', metrics: { lcp: 3300 } }),
    makeReport({ score: 51, fetchTime: 'c', metrics: { lcp: 3350 } }),
  ];
  const afterRuns = [
    makeReport({ score: 70, fetchTime: 'd', metrics: { lcp: 2200 } }),
    makeReport({ score: 72, fetchTime: 'e', metrics: { lcp: 2250 } }),
    makeReport({ score: 71, fetchTime: 'f', metrics: { lcp: 2180 } }),
  ];
  await saveReport(
    applyTargets(aggregateReports(beforeRuns, { reportId: BEFORE_ID, runsRequested: 3 })),
    beforeRuns,
    dir,
  );
  await saveReport(
    applyTargets(aggregateReports(afterRuns, { reportId: AFTER_ID, runsRequested: 3 })),
    afterRuns,
    dir,
  );

  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.PSI_DATA_DIR;
  else process.env.PSI_DATA_DIR = previousDataDir;
});

describe('GET /reports', () => {
  it('lists stored reports newest first with picker fields', async () => {
    const response = await app.inject({ method: 'GET', url: '/reports' });
    expect(response.statusCode).toBe(200);
    const { reports } = response.json();
    expect(reports.map((r: { reportId: string }) => r.reportId)).toEqual([AFTER_ID, BEFORE_ID]);
    const first = reports[0];
    expect(first.host).toBe('example.com');
    expect(first.strategy).toBe('mobile');
    expect(first.runsSucceeded).toBe(3);
    expect(first.score).toBe(71);
    expect(typeof first.meetsTarget).toBe('boolean');
    expect(first.targetsTotal).toBeGreaterThan(0);
    expect(first.targetsFailing).toBeLessThanOrEqual(first.targetsTotal);
  });
});

describe('POST /reanalyze', () => {
  it('rebuilds one report without writing when save is false', async () => {
    const file = path.join(dir, 'example.com', BEFORE_ID, 'report.json');
    const original = await readFile(file, 'utf8');
    const response = await app.inject({
      method: 'POST',
      url: '/reanalyze',
      payload: { reportId: BEFORE_ID, save: false },
    });
    expect(response.statusCode).toBe(200);
    const { reanalyzed } = response.json();
    expect(reanalyzed).toHaveLength(1);
    expect(reanalyzed[0]).toMatchObject({ reportId: BEFORE_ID, saved: false });
    expect(reanalyzed[0].delta).toBeTruthy();
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('sweeps every stored report when no id is given, and keeps runs.json', async () => {
    const runsFile = path.join(dir, 'example.com', AFTER_ID, 'runs.json');
    const runsBefore = await readFile(runsFile, 'utf8');
    const { reanalyzed } = (await app.inject({ method: 'POST', url: '/reanalyze', payload: {} })).json();
    expect(reanalyzed.map((r: { reportId: string }) => r.reportId).sort()).toEqual([AFTER_ID, BEFORE_ID].sort());
    expect(reanalyzed.every((r: { saved: boolean }) => r.saved)).toBe(true);
    expect(await readFile(runsFile, 'utf8')).toBe(runsBefore);
    expect((await loadReport(AFTER_ID, dir))!.reportId).toBe(AFTER_ID);
  });

  it('refuses a POST that is not JSON, which another site could send', async () => {
    const file = path.join(dir, 'example.com', BEFORE_ID, 'report.json');
    const original = await readFile(file, 'utf8');
    const bare = await app.inject({ method: 'POST', url: '/reanalyze' });
    expect(bare.statusCode).toBe(415);
    expect(bare.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    const text = await app.inject({
      method: 'POST',
      url: '/reanalyze',
      headers: { 'content-type': 'text/plain' },
      payload: '{"save":true}',
    });
    expect(text.statusCode).toBe(415);
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('404s for an unknown report', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/reanalyze',
      payload: { reportId: '2026-01-01T00-00-00Z-mobile' },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /targets', () => {
  it('returns config/targets.json', async () => {
    const body = (await app.inject({ method: 'GET', url: '/targets' })).json();
    expect(body).toEqual(loadTargets());
    expect(body.mobile.score).toBeDefined();
    expect(body.desktop.lcp).toBeDefined();
  });
});

describe('runs through the server', () => {
  it('records live per-run progress on an async job, and save=false writes nothing', async () => {
    const psi = fakePsi();
    const server = buildServer({ fetchImpl: psi.impl, sleepImpl: async () => {} });
    await server.ready();
    try {
      const countBefore = (await listReports(dir)).length;
      const started = await server.inject({
        method: 'POST',
        url: '/report',
        payload: { url: 'https://example.com/', runs: 3, async: true, save: false },
      });
      expect(started.statusCode).toBe(202);
      const job = await waitForJob(server, started.json().jobId);
      expect(job.status).toBe('done');
      expect(job.save).toBe(false);
      expect(job.progress).toHaveLength(3);
      expect(job.progress.map((p: { run: number }) => p.run).sort()).toEqual([1, 2, 3]);
      expect(job.progress.every((p: { ok: boolean; score: number }) => p.ok && p.score === 80)).toBe(true);
      expect(job.result.runsSucceeded).toBe(3);
      expect(psi.calls()).toBe(3);
      expect((await listReports(dir)).length).toBe(countBefore);
    } finally {
      await server.close();
    }
  });

  it('saves by default, so the new report shows up in /reports', async () => {
    const psi = fakePsi();
    const server = buildServer({ fetchImpl: psi.impl, sleepImpl: async () => {} });
    await server.ready();
    try {
      const response = await server.inject({
        method: 'GET',
        url: '/report?url=https%3A%2F%2Fexample.com%2F&runs=2&force=true',
      });
      expect(response.statusCode).toBe(200);
      const { reportId } = response.json();
      const { reports } = (await server.inject({ method: 'GET', url: '/reports' })).json();
      expect(reports[0].reportId).toBe(reportId);
    } finally {
      await server.close();
    }
  });
});
