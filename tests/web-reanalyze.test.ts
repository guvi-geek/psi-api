/** Re-analyze on a report measures the page again with that report's own settings. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { aggregateReports } from '../src/aggregate.js';
import { applyTargets } from '../src/targets.js';
import { saveReport, loadReport } from '../src/storage.js';
import { buildServer } from '../src/server.js';
import { rerunRequest } from '../web/src/reanalyze.js';
import { makeReport } from './helpers.js';

const BEFORE = '2026-11-20T10-00-00Z-mobile';
let dir: string;
let app: FastifyInstance;
let previousDataDir: string | undefined;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'psi-api-reanalyze-'));
  previousDataDir = process.env.PSI_DATA_DIR;
  process.env.PSI_DATA_DIR = dir;
  const slow = [0, 1, 2, 3].map((i) => makeReport({ fetchTime: `s${i}`, metrics: { lcp: 3300 + i * 20 } }));
  await saveReport(applyTargets(aggregateReports(slow, { reportId: BEFORE, runsRequested: 4 })), slow, dir);
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.PSI_DATA_DIR;
  else process.env.PSI_DATA_DIR = previousDataDir;
});

describe('re-analyze on a report', () => {
  it('measures the same page again with the settings of the report, saved', () => {
    expect(
      rerunRequest({ url: 'https://site.test/a', strategy: 'desktop', runsRequested: 15, stat: 'mean' }),
    ).toEqual({ url: 'https://site.test/a', strategy: 'desktop', runs: 15, stat: 'mean', save: true });
  });

  it('starts a real job on the server with those settings', async () => {
    const report = (await loadReport(BEFORE, dir))!;
    const request = rerunRequest(report);
    expect(request).toMatchObject({ url: report.url, strategy: report.strategy, runs: report.runsRequested });
    // Validated by the same route the run form uses; async=true returns a job id.
    // fetch is never reached here: the job starts and this test does not wait on it.
    const fake = buildServer({ fetchImpl: (async () => new Response('{}', { status: 500 })) as typeof fetch, sleepImpl: async () => {} });
    await fake.ready();
    try {
      const started = await fake.inject({ method: 'POST', url: '/report', payload: { ...request, async: true } });
      expect(started.statusCode).toBe(202);
      const job = (await fake.inject({ method: 'GET', url: `/jobs/${started.json().jobId}` })).json();
      expect(job.request).toEqual({ url: report.url, strategy: report.strategy, runs: report.runsRequested, stat: report.stat });
      expect(job.save).toBe(true);
    } finally {
      await fake.close();
    }
  });
});
