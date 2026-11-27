/** runReport saves through the store it is given, and a failed categories save keeps the measurement. */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runReport } from '../src/runner.js';
import { FileStore } from '../src/report-store.js';

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
});
