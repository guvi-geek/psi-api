/** Compare and Re-analyze in the UI: the CLI's verdict and rebuild, put into words. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { aggregateReports } from '../src/aggregate.js';
import { applyTargets } from '../src/targets.js';
import { saveReport, loadReport } from '../src/storage.js';
import { buildServer } from '../src/server.js';
import { parseArgs } from '../src/cli.js';
import { compareReports } from '../src/compare.js';
import type { ReanalyzeDelta } from '../src/reanalyze.js';
import {
  changeText,
  compareCli,
  compareQuery,
  compareSides,
  isCompareMetric,
  mismatch,
  previousOf,
  reanalyzeLines,
  reanalyzeSummary,
  reportOption,
  requestChanges,
  type CompareResponse,
} from '../web/src/compare.js';
import type { ReportRow } from '../web/src/run.js';
import { makeReport } from './helpers.js';

const BEFORE = '2026-11-20T10-00-00Z-mobile';
const AFTER = '2026-11-21T10-00-00Z-mobile';
let dir: string;
let app: FastifyInstance;
let previousDataDir: string | undefined;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'psi-api-compare-'));
  previousDataDir = process.env.PSI_DATA_DIR;
  process.env.PSI_DATA_DIR = dir;
  const slow = [0, 1, 2, 3].map((i) => makeReport({ fetchTime: `s${i}`, metrics: { lcp: 3300 + i * 20 } }));
  const fast = [0, 1, 2, 3].map((i) => makeReport({ fetchTime: `f${i}`, metrics: { lcp: 2100 + i * 20 } }));
  await saveReport(applyTargets(aggregateReports(slow, { reportId: BEFORE, runsRequested: 4 })), slow, dir);
  await saveReport(applyTargets(aggregateReports(fast, { reportId: AFTER, runsRequested: 4 })), fast, dir);
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.PSI_DATA_DIR;
  else process.env.PSI_DATA_DIR = previousDataDir;
});

describe('compare', () => {
  it('asks the server for the same verdict the CLI command gives', async () => {
    const result: CompareResponse = (
      await app.inject({ method: 'GET', url: `/compare?${compareQuery(BEFORE, AFTER, 'lcp')}` })
    ).json();
    const cli = parseArgs(compareCli(BEFORE, AFTER, 'lcp').replace(/^npm run psi -- /, '').split(' '))!;
    expect(cli.compare).toEqual([BEFORE, AFTER]);
    expect(cli.metric).toEqual(['lcp']);
    const fromCli = compareReports((await loadReport(BEFORE, dir))!, (await loadReport(AFTER, dir))!, cli.metric![0]!);
    const { beforeId, afterId, ...fromServer } = result;
    expect(fromServer).toEqual(fromCli);
    expect([beforeId, afterId]).toEqual([BEFORE, AFTER]);
    expect(result.verdict).toBe('KEEP');

    const sides = compareSides(result);
    expect(sides.map((side) => side.label)).toEqual(['Before', 'After']);
    expect(sides[0]!.p75).toMatch(/^\d+ms$/);
    expect(changeText('lcp', result.p75Delta)).toMatch(/^\d+ms better at p75$/);
  });

  it('leaves out --metric when the default is wanted', () => {
    expect(compareCli('a', 'b')).toBe('npm run psi -- --compare a b');
    expect(compareQuery('a', 'b')).toBe('before=a&after=b');
    expect(isCompareMetric('lcp')).toBe(true);
    expect(isCompareMetric('score')).toBe(false);
    expect(isCompareMetric(null)).toBe(false);
  });

  it('words a change in either direction', () => {
    expect(changeText('lcp', -120.4)).toBe('120ms worse at p75');
    expect(changeText('cls', 0.02)).toBe('0.020 better at p75');
    expect(changeText('tbt', 0)).toBe('No change at p75');
  });

  it('lists request changes, or says there is no request table', () => {
    const base = {
      beforeId: 'a',
      afterId: 'b',
      metric: 'lcp',
      verdict: 'KEEP',
      reason: '',
      p75Delta: 1,
      before: { p75: 1, stddev: 1 },
      after: { p75: 1, stddev: 1 },
      bimodal: false,
      cautions: [],
    } as unknown as CompareResponse;
    expect(
      requestChanges({
        ...base,
        requests: {
          available: true,
          documentBytesBefore: 90_000,
          documentBytesAfter: 60_000,
          notFoundResolved: ['site/a.js'],
          notFoundIntroduced: [],
          thirdPartyArrived: ['ads.example'],
          thirdPartyLeft: [],
        },
      }),
    ).toEqual({
      document: '88KB → 59KB',
      changes: [
        { label: '404s resolved', items: ['site/a.js'] },
        { label: '404s introduced', items: [] },
        { label: 'Third parties arrived', items: ['ads.example'] },
        { label: 'Third parties left', items: [] },
      ],
    });
    expect(requestChanges({ ...base, requests: { available: false } as CompareResponse['requests'] })).toBeNull();
  });
});

const row = (overrides: Partial<ReportRow>): ReportRow => ({
  reportId: 'x',
  host: 'site.test',
  url: 'https://site.test/',
  strategy: 'mobile',
  stat: 'median',
  generatedAt: '2026-11-26T10:00:00.000Z',
  runsRequested: 10,
  runsSucceeded: 10,
  score: 91.6,
  lcp: 2000,
  meetsTarget: true,
  targetsFailing: 0,
  targetsTotal: 6,
  ...overrides,
});

describe('picking reports', () => {
  const reports = [
    row({ reportId: 'r4', generatedAt: '2026-11-26T12:00:00.000Z' }),
    row({ reportId: 'r3', strategy: 'desktop' }),
    row({ reportId: 'r2', url: 'https://site.test/other' }),
    row({ reportId: 'r1', generatedAt: '2026-11-25T09:30:00.000Z' }),
  ];

  it('finds the previous report of the same page and device', () => {
    expect(previousOf(reports, 'r4')?.reportId).toBe('r1');
    expect(previousOf(reports, 'r1')).toBeUndefined();
    expect(previousOf(reports, 'missing')).toBeUndefined();
  });

  it('says when two reports are not like for like', () => {
    expect(mismatch(reports[0], reports[3])).toBeNull();
    expect(mismatch(reports[0], reports[1])).toBe('These reports measure different devices.');
    expect(mismatch(reports[1], reports[2])).toBe('These reports measure different pages and different devices.');
    expect(mismatch(reports[0], reports[0])).toBe('Before and after are the same report.');
    expect(mismatch(undefined, reports[0])).toBeNull();
  });

  it('reads well in a picker', () => {
    expect(reportOption(reports[0]!)).toBe('site.test/, mobile, 2026-11-26 12:00, score 92');
  });
});

describe('re-analyze', () => {
  const delta: ReanalyzeDelta = {
    reportId: 'r',
    recovered: [
      { insightId: 'unused-javascript', beforeMs: 0, afterMs: 340, beforeBytes: 0, afterBytes: 86_000, source: 'items' },
      { insightId: 'cache-insight', beforeMs: 0, afterMs: null, beforeBytes: 0, afterBytes: 0, source: 'none' },
    ],
    phantomZeroes: ['bootup-time'],
    scoreBefore: 90,
    scoreAfter: 90,
    failingBefore: ['lcp'],
    failingAfter: ['lcp', 'tbt'],
    meetsTargetBefore: false,
    meetsTargetAfter: false,
    changed: true,
  };

  it('words each change as the CLI does', () => {
    expect(reanalyzeLines(delta)).toEqual([
      { tone: 'good', text: 'Recovered unused-javascript: recorded as 0, Lighthouse actually measured 340ms / 84KB (found in items)' },
      { tone: 'good', text: 'Recovered cache-insight: recorded as 0, Lighthouse actually measured no time saving (provenance not recoverable from the stored run)' },
      { tone: 'warn', text: 'Corrected bootup-time: claimed a 0ms saving that Lighthouse never gave an estimate for' },
      { tone: 'bad', text: 'Now failing: LCP, TBT' },
    ]);
  });

  it('adds up a sweep like the CLI header', () => {
    const summary = reanalyzeSummary([
      { reportId: 'r', delta, saved: false },
      { reportId: 's', delta: { ...delta, changed: false, recovered: [], phantomZeroes: [] }, saved: false },
      { reportId: 't', delta: null, error: 'no stored runs', saved: false },
    ]);
    expect(summary).toEqual({ total: 3, changed: 1, recovered: 2, phantoms: 1, failed: 1, saved: 0 });
  });

  it('previews without writing, then saves, through the same route', async () => {
    const preview = (await app.inject({ method: 'POST', url: '/reanalyze', payload: { reportId: BEFORE, save: false } })).json();
    expect(reanalyzeSummary(preview.reanalyzed)).toMatchObject({ total: 1, saved: 0, failed: 0 });
    const applied = (await app.inject({ method: 'POST', url: '/reanalyze', payload: { reportId: BEFORE, save: true } })).json();
    expect(reanalyzeSummary(applied.reanalyzed)).toMatchObject({ total: 1, saved: 1 });
  });
});
