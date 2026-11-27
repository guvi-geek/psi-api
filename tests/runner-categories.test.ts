/**
 * A run asks PSI for every category in its one call. The saved performance
 * report must be what performance-only calls produced, and categories.json must
 * hold the median run's other categories.
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runReport } from '../src/runner.js';
import { loadCategories, loadReport } from '../src/storage.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ALL = JSON.parse(readFileSync(path.join(here, 'fixtures', 'raw-all-categories-real.json'), 'utf8'));
const URL_ = 'https://www.guvi.in/zen-class/';
// Performance and accessibility scores of three runs. 0.83 is the median run.
const RUNS = [
  { performance: 0.9, accessibility: 0.91 },
  { performance: 0.8, accessibility: 0.92 },
  { performance: 0.83, accessibility: 0.93 },
];

function response(index: number, performanceOnly: boolean) {
  const raw = JSON.parse(JSON.stringify(ALL));
  const lh = raw.lighthouseResult;
  lh.fetchTime = `2026-11-27T10:00:0${index}.000Z`;
  lh.categories.performance.score = RUNS[index]!.performance;
  lh.categories.accessibility.score = RUNS[index]!.accessibility;
  if (performanceOnly) {
    const perf = new Set(lh.categories.performance.auditRefs.map((ref: { id: string }) => ref.id));
    for (const id of Object.keys(lh.categories)) {
      if (id === 'performance') continue;
      for (const ref of lh.categories[id].auditRefs) if (!perf.has(ref.id)) delete lh.audits[ref.id];
      delete lh.categories[id];
    }
    lh.configSettings.onlyCategories = ['performance'];
  }
  return raw;
}

/** A PSI stand-in that answers run by run and records what each call asked for. */
function fakePsi(performanceOnly: boolean) {
  const asked: string[][] = [];
  let call = 0;
  const fetchImpl = (async (input: string | URL) => {
    asked.push(new URL(String(input)).searchParams.getAll('category'));
    const body = response(call++, performanceOnly);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, asked };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'psi-api-categories-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const options = (fetchImpl: typeof fetch) => ({
  url: URL_,
  runs: 3,
  concurrency: 1,
  apiKey: 'test-key',
  fetchImpl,
  sleepImpl: async () => {},
  dataDir: dir,
});

describe('a run reads every category in its one call', () => {
  it('asks PSI for all five categories, once per run', async () => {
    const psi = fakePsi(false);
    await runReport({ ...options(psi.fetchImpl), save: false });
    expect(psi.asked).toHaveLength(3);
    for (const categories of psi.asked) {
      expect(categories).toEqual(['PERFORMANCE', 'ACCESSIBILITY', 'BEST_PRACTICES', 'SEO', 'AGENTIC_BROWSING']);
    }
  });

  it('saves the same performance report that performance-only calls produced', async () => {
    const all = await runReport({ ...options(fakePsi(false).fetchImpl), save: false });
    const only = await runReport({ ...options(fakePsi(true).fetchImpl), save: false });
    const comparable = (report: typeof all.report) => ({ ...report, reportId: '', generatedAt: '' });
    expect(comparable(all.report)).toEqual(comparable(only.report));
    expect(all.runs).toEqual(only.runs);
    expect(all.report.environment.categories).toEqual(['performance']);
    expect(only.categories).toEqual({});
  });

  it('keeps the median run’s categories beside the report', async () => {
    const result = await runReport({ ...options(fakePsi(false).fetchImpl), save: true });
    // The median score is 83, so the third run is the one the report describes.
    expect(result.categories.accessibility!.score).toBe(93);
    expect(Object.keys(result.categories)).toEqual(['accessibility', 'best-practices', 'seo', 'agentic-browsing']);

    const host = path.join(dir, 'www.guvi.in', result.report.reportId);
    expect((await readdir(host)).sort()).toEqual(['categories.json', 'report.json', 'runs.json']);
    expect(await loadCategories(result.report.reportId, dir)).toEqual(result.categories);
    expect(await loadReport(result.report.reportId, dir)).toEqual(result.report);
    expect(JSON.parse(await readFile(path.join(host, 'runs.json'), 'utf8'))).toEqual(result.runs);
  });

  it('writes no categories.json when PSI returned only performance', async () => {
    const result = await runReport({ ...options(fakePsi(true).fetchImpl), save: true });
    expect(await readdir(path.join(dir, 'www.guvi.in', result.report.reportId))).not.toContain('categories.json');
    expect(await loadCategories(result.report.reportId, dir)).toBeNull();
  });
});
