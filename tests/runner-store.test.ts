/** runReport saves through the store it is given, and a failed categories save keeps the measurement. */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runReport } from '../src/runner.js';
import { FileStore } from '../src/report-store.js';
import { buildServer } from '../src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ALL = JSON.parse(readFileSync(path.join(here, 'fixtures', 'raw-all-categories-real.json'), 'utf8'));
let calls = 0;
const fetchImpl = (async () => {
  const raw = JSON.parse(JSON.stringify(ALL));
  raw.lighthouseResult.fetchTime = `2026-11-27T10:00:0${calls++ % 10}.000Z`;
  return new Response(JSON.stringify(raw), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'psi-api-runner-store-'));
  calls = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('runReport with a store', () => {
  it('saves through the given store, not data/', async () => {
    const store = new FileStore(dir);
    const result = await runReport({ url: 'https://www.guvi.in/zen-class/', runs: 2, apiKey: 'k', fetchImpl, sleepImpl: async () => {}, store });
    expect(result.dir).toBe(path.join(dir, 'www.guvi.in', result.report.reportId));
    expect(await store.loadReport(result.report.reportId)).not.toBeNull();
    expect(await store.loadCategories(result.report.reportId)).not.toBeNull();
  });

  it('keeps the measurement, with a warning, when only the categories save fails', async () => {
    class BrokenCategories extends FileStore {
      override async saveCategories(): Promise<void> {
        throw new Error('connection reset');
      }
    }
    const store = new BrokenCategories(dir);
    const result = await runReport({ url: 'https://www.guvi.in/zen-class/', runs: 2, apiKey: 'k', fetchImpl, sleepImpl: async () => {}, store });
    expect(result.warnings).toContain('Saved the report but not its other categories (SEO and more): connection reset');
    expect(await store.loadReport(result.report.reportId)).not.toBeNull();
    expect(await readdir(path.join(dir, 'www.guvi.in', result.report.reportId))).toEqual(['report.json', 'runs.json']);
  });

  it('keeps the measurement, unsaved and with a warning, when the report save fails twice (#4)', async () => {
    let tries = 0;
    let categoriesSaved = false;
    class BrokenStore extends FileStore {
      override async saveReport(): Promise<{ reportId: string; location: string }> {
        tries += 1;
        throw new Error('tunnel dropped');
      }
      override async saveCategories(): Promise<void> {
        categoriesSaved = true;
      }
    }
    const store = new BrokenStore(dir);
    const result = await runReport({ url: 'https://www.guvi.in/zen-class/', runs: 2, apiKey: 'k', fetchImpl, sleepImpl: async () => {}, store });
    expect(tries).toBe(2);
    expect(result.saved).toBe(false);
    expect(result.report.runsSucceeded).toBe(2);
    expect(result.dir).toBeUndefined();
    expect(categoriesSaved).toBe(false);
    expect(result.warnings).toContain(
      'Measured, but the report could not be saved: tunnel dropped. It is shown here only and is gone when the server restarts.',
    );
  });

  it('saves on the second try after one failed write', async () => {
    let tries = 0;
    class FlakyStore extends FileStore {
      override async saveReport(...args: Parameters<FileStore['saveReport']>) {
        tries += 1;
        if (tries === 1) throw new Error('timeout');
        return super.saveReport(...args);
      }
    }
    const store = new FlakyStore(dir);
    const result = await runReport({ url: 'https://www.guvi.in/zen-class/', runs: 2, apiKey: 'k', fetchImpl, sleepImpl: async () => {}, store });
    expect(tries).toBe(2);
    expect(result.saved).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(await store.loadReport(result.report.reportId)).not.toBeNull();
  });

  it('says saved is false with saving off, and true when the store took it', async () => {
    const off = await runReport({ url: 'https://www.guvi.in/zen-class/', runs: 1, apiKey: 'k', fetchImpl, sleepImpl: async () => {}, save: false, store: new FileStore(dir) });
    expect(off.saved).toBe(false);
    const on = await runReport({ url: 'https://www.guvi.in/zen-class/', runs: 1, apiKey: 'k', fetchImpl, sleepImpl: async () => {}, store: new FileStore(dir) });
    expect(on.saved).toBe(true);
  });
});

describe('the server when the report cannot be saved (#4)', () => {
  class BrokenStore extends FileStore {
    override async saveReport(): Promise<{ reportId: string; location: string }> {
      throw new Error('tunnel dropped');
    }
  }

  it('finishes the job with the report, saved false and the reason, so the UI shows it instead of opening a missing report', async () => {
    const app = buildServer({ store: new BrokenStore(dir), fetchImpl, sleepImpl: async () => {} });
    await app.ready();
    try {
      const started = await app.inject({ method: 'POST', url: '/report', payload: { url: 'https://www.guvi.in/zen-class/', runs: 1, async: true } });
      const { jobId } = started.json();
      let job: Record<string, unknown> = {};
      for (let i = 0; i < 50 && job.status !== 'done' && job.status !== 'failed'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        job = (await app.inject({ method: 'GET', url: `/jobs/${jobId}` })).json();
      }
      expect(job.status).toBe('done');
      expect(job.saved).toBe(false);
      expect((job.result as { reportId: string }).reportId).toMatch(/-mobile-[0-9a-f]{6}$/);
      expect(job.warnings).toEqual([expect.stringContaining('Measured, but the report could not be saved: tunnel dropped')]);
    } finally {
      await app.close();
    }
  });

  it('answers a synchronous request with the report and an x-psi-not-saved header', async () => {
    const app = buildServer({ store: new BrokenStore(dir), fetchImpl, sleepImpl: async () => {} });
    await app.ready();
    try {
      const response = await app.inject({ method: 'POST', url: '/report', payload: { url: 'https://www.guvi.in/zen-class/', runs: 1 } });
      expect(response.statusCode).toBe(200);
      expect(response.json().runsSucceeded).toBe(1);
      expect(response.headers['x-psi-not-saved']).toMatch(/^Measured, but the report could not be saved: tunnel dropped/);
    } finally {
      await app.close();
    }
  });
});
