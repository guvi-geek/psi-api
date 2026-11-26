/**
 * The SEO routes: POST /seo runs one PSI call with category=seo and saves it
 * under data/<host>/seo/, GET /seo/:seoId reads one back, GET /seo lists them.
 * PSI is always a fake here; data/ is a temp dir.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { normalizeSeo, type SeoCheck } from '../src/seo.js';
import { saveSeoCheck } from '../src/seo-storage.js';
import { aggregateReports } from '../src/aggregate.js';
import { applyTargets } from '../src/targets.js';
import { saveReport } from '../src/storage.js';
import { fakeResponse, makeReport, PSI_ERROR_BODY } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RAW = JSON.parse(readFileSync(path.join(here, 'fixtures', 'raw-seo-real.json'), 'utf8')) as unknown;
const PAGE = 'https://www.guvi.in/zen-class/devops-course/';
const HOST = 'www.guvi.in';

let dir: string;
let previousDataDir: string | undefined;
let previousKey: string | undefined;

/** A PSI stand-in that records every request and answers with the real SEO fixture. */
function fakePsi(respond: () => Response = () => fakeResponse(JSON.parse(JSON.stringify(RAW)))) {
  const requests: URL[] = [];
  const impl = (async (input: string | URL | Request) => {
    requests.push(new URL(String(input)));
    return respond();
  }) as unknown as typeof fetch;
  return { impl, requests };
}

async function serverWith(fetchImpl: typeof fetch): Promise<FastifyInstance> {
  const app = buildServer({ fetchImpl, sleepImpl: async () => {} });
  await app.ready();
  return app;
}

const postJson = (app: FastifyInstance, payload: unknown) =>
  app.inject({ method: 'POST', url: '/seo', payload: payload as object });

async function seoFiles(host = HOST): Promise<string[]> {
  try {
    return await readdir(path.join(dir, host, 'seo'));
  } catch {
    return [];
  }
}

beforeAll(() => {
  previousDataDir = process.env.PSI_DATA_DIR;
  previousKey = process.env.PSI_API_KEY;
  process.env.PSI_API_KEY = 'test-key';
});

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.PSI_DATA_DIR;
  else process.env.PSI_DATA_DIR = previousDataDir;
  if (previousKey === undefined) delete process.env.PSI_API_KEY;
  else process.env.PSI_API_KEY = previousKey;
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'psi-api-server-seo-'));
  process.env.PSI_DATA_DIR = dir;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('POST /seo', () => {
  it('makes exactly one PSI call with category=seo, saves the check and returns it', async () => {
    const psi = fakePsi();
    const app = await serverWith(psi.impl);
    try {
      const response = await postJson(app, { url: PAGE, strategy: 'desktop' });
      expect(response.statusCode).toBe(200);
      expect(psi.requests).toHaveLength(1);
      const sent = psi.requests[0]!.searchParams;
      expect(sent.getAll('category')).toEqual(['seo']);
      expect(sent.get('strategy')).toBe('desktop');
      expect(sent.get('key')).toBe('test-key');
      expect(sent.get('url')).toMatch(/^https:\/\/www\.guvi\.in\/zen-class\/devops-course\/\?psi_nonce=/);

      const { check, saved } = response.json() as { check: SeoCheck; saved: boolean };
      expect(saved).toBe(true);
      expect(check.url).toBe(PAGE);
      expect(check.strategy).toBe('desktop');
      expect(check.seoId).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-desktop-seo$/);
      expect(check.audits.length).toBeGreaterThan(0);

      const file = path.join(dir, HOST, 'seo', `${check.seoId}.json`);
      expect(existsSync(file)).toBe(true);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(check);
    } finally {
      await app.close();
    }
  });

  it('defaults to mobile and normalises the URL as /report does', async () => {
    const psi = fakePsi();
    const app = await serverWith(psi.impl);
    try {
      const response = await postJson(app, { url: '  https://www.guvi.in  ' });
      expect(response.statusCode).toBe(200);
      expect(psi.requests[0]!.searchParams.get('strategy')).toBe('mobile');
      expect(response.json().check.url).toBe('https://www.guvi.in/');
      expect(response.json().check.strategy).toBe('mobile');
    } finally {
      await app.close();
    }
  });

  it('writes nothing with save:false and says so', async () => {
    const psi = fakePsi();
    const app = await serverWith(psi.impl);
    try {
      const response = await postJson(app, { url: PAGE, save: false });
      expect(response.statusCode).toBe(200);
      expect(response.json().saved).toBe(false);
      expect(response.json().check.url).toBe(PAGE);
      expect(psi.requests).toHaveLength(1);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('warns about a private host but still runs it, as /report does', async () => {
    const psi = fakePsi();
    const app = await serverWith(psi.impl);
    try {
      const response = await postJson(app, { url: 'http://localhost:3000/', save: false });
      expect(response.statusCode).toBe(200);
      expect(psi.requests).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('refuses a non-JSON body with 415 before calling PSI', async () => {
    const psi = fakePsi();
    const app = await serverWith(psi.impl);
    try {
      const textPlain = await app.inject({
        method: 'POST',
        url: '/seo',
        headers: { 'content-type': 'text/plain' },
        payload: JSON.stringify({ url: PAGE }),
      });
      expect(textPlain.statusCode).toBe(415);
      expect(textPlain.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');

      const noBody = await app.inject({ method: 'POST', url: '/seo' });
      expect(noBody.statusCode).toBe(415);

      expect(psi.requests).toHaveLength(0);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('rejects a bad URL and a bad strategy with the codes /report uses', async () => {
    const psi = fakePsi();
    const app = await serverWith(psi.impl);
    try {
      for (const payload of [
        { url: 'file:///app/index.html' },
        { url: 'not a url' },
        { url: 'ftp://example.com/' },
      ]) {
        const seo = await postJson(app, payload);
        const report = await app.inject({ method: 'POST', url: '/report', payload: { ...payload, runs: 1 } });
        expect(seo.statusCode).toBe(400);
        expect(seo.json().error.code).toBe('INVALID_URL');
        expect(seo.statusCode).toBe(report.statusCode);
        expect(seo.json()).toEqual(report.json());
      }

      const missing = await postJson(app, { strategy: 'mobile' });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error.code).toBe('INVALID_PARAMS');

      const badStrategy = await postJson(app, { url: PAGE, strategy: 'tablet' });
      const reportBadStrategy = await app.inject({
        method: 'POST',
        url: '/report',
        payload: { url: PAGE, strategy: 'tablet', runs: 1 },
      });
      expect(badStrategy.statusCode).toBe(400);
      expect(badStrategy.json().error.code).toBe('INVALID_PARAMS');
      expect(badStrategy.json()).toEqual(reportBadStrategy.json());

      expect(psi.requests).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  for (const [label, respond] of [
    ['HTTP 500', () => fakeResponse({ error: { code: 500, message: 'Internal error' } }, { status: 500 })],
    ['HTTP 429', () => fakeResponse(PSI_ERROR_BODY, { status: 429 })],
    ['HTTP 400 (not retried)', () => fakeResponse({ error: { code: 400, message: 'Lighthouse returned error: NO_FCP' } }, { status: 400 })],
  ] as const) {
    it(`maps a PSI failure (${label}) the way /report maps it`, async () => {
      const seoPsi = fakePsi(respond);
      const seoApp = await serverWith(seoPsi.impl);
      const reportPsi = fakePsi(respond);
      const reportApp = await serverWith(reportPsi.impl);
      try {
        const seo = await postJson(seoApp, { url: PAGE, save: false });
        const report = await reportApp.inject({
          method: 'POST',
          url: '/report',
          payload: { url: PAGE, runs: 1, save: false, force: true },
        });
        expect(report.statusCode).toBe(502);
        expect(seo.statusCode).toBe(report.statusCode);
        expect(seo.json()).toEqual(report.json());
        expect(seo.json().error.code).toBe('INSUFFICIENT_RUNS');
        // Same retries on both sides: the SEO check is one PSI call with its retries.
        expect(seoPsi.requests.length).toBe(reportPsi.requests.length);
        expect(await readdir(dir)).toEqual([]);
      } finally {
        await seoApp.close();
        await reportApp.close();
      }
    });
  }
});

/* ------------------------------ reading checks ------------------------------ */

const ids = {
  oldMobile: '2026-11-20T10-00-00Z-mobile-seo',
  newMobile: '2026-11-25T10-00-00Z-mobile-seo',
  desktop: '2026-11-22T10-00-00Z-desktop-seo',
  otherPage: '2026-11-24T10-00-00Z-mobile-seo',
};

async function seed(): Promise<Record<keyof typeof ids, SeoCheck>> {
  const make = (url: string, strategy: 'mobile' | 'desktop', seoId: string) =>
    normalizeSeo(JSON.parse(JSON.stringify(RAW)), { url, strategy, seoId });
  const checks = {
    oldMobile: make(PAGE, 'mobile', ids.oldMobile),
    newMobile: make(PAGE, 'mobile', ids.newMobile),
    desktop: make(PAGE, 'desktop', ids.desktop),
    otherPage: make('https://www.guvi.in/', 'mobile', ids.otherPage),
  };
  for (const check of Object.values(checks)) await saveSeoCheck(check, dir);
  return checks;
}

describe('GET /seo/:seoId', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await serverWith(fakePsi().impl);
  });
  afterEach(async () => {
    await app.close();
  });

  it('returns a stored check', async () => {
    const checks = await seed();
    const response = await app.inject({ method: 'GET', url: `/seo/${ids.desktop}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(checks.desktop);
  });

  it('reads back what POST /seo saved', async () => {
    const posted = (await postJson(app, { url: PAGE })).json() as { check: SeoCheck };
    const response = await app.inject({ method: 'GET', url: `/seo/${posted.check.seoId}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(posted.check);
  });

  it('400s with INVALID_PARAMS on an id that is not an SEO id', async () => {
    for (const bad of ['..%2Fx', '2026-11-20T10-00-00Z-mobile', 'nope']) {
      const response = await app.inject({ method: 'GET', url: `/seo/${bad}` });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INVALID_PARAMS');
      expect(typeof response.json().error.message).toBe('string');
    }
  });

  it('404s like /report/:reportId on a well-formed unknown id', async () => {
    const response = await app.inject({ method: 'GET', url: '/seo/2020-01-01T00-00-00Z-mobile-seo' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'no stored SEO check "2020-01-01T00-00-00Z-mobile-seo"' },
    });
    const report = await app.inject({ method: 'GET', url: '/report/2020-01-01T00-00-00Z-mobile' });
    expect(Object.keys(report.json().error)).toEqual(Object.keys(response.json().error));
  });
});

describe('GET /seo', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await serverWith(fakePsi().impl);
  });
  afterEach(async () => {
    await app.close();
  });

  it('is an empty list with nothing stored', async () => {
    const response = await app.inject({ method: 'GET', url: '/seo' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ checks: [] });
  });

  it('lists every check newest first, as summaries', async () => {
    const checks = await seed();
    const response = await app.inject({ method: 'GET', url: '/seo' });
    expect(response.statusCode).toBe(200);
    const listed = response.json().checks as Array<Record<string, unknown>>;
    expect(listed.map((entry) => entry.seoId)).toEqual([ids.newMobile, ids.otherPage, ids.desktop, ids.oldMobile]);
    expect(listed[0]).toEqual({
      seoId: ids.newMobile,
      host: HOST,
      url: PAGE,
      strategy: 'mobile',
      fetchedAt: checks.newMobile.fetchedAt,
      score: checks.newMobile.score,
      counts: checks.newMobile.counts,
    });
  });

  it('filters by exact url and by strategy', async () => {
    await seed();
    const byUrl = await app.inject({ method: 'GET', url: `/seo?url=${encodeURIComponent(PAGE)}` });
    expect(byUrl.json().checks.map((entry: { seoId: string }) => entry.seoId)).toEqual([
      ids.newMobile,
      ids.desktop,
      ids.oldMobile,
    ]);

    const byBoth = await app.inject({ method: 'GET', url: `/seo?url=${encodeURIComponent(PAGE)}&strategy=desktop` });
    expect(byBoth.json().checks.map((entry: { seoId: string }) => entry.seoId)).toEqual([ids.desktop]);

    const byStrategy = await app.inject({ method: 'GET', url: '/seo?strategy=mobile' });
    expect(byStrategy.json().checks.map((entry: { seoId: string }) => entry.seoId)).toEqual([
      ids.newMobile,
      ids.otherPage,
      ids.oldMobile,
    ]);

    // Exact match: the un-normalised form of the page does not match.
    const loose = await app.inject({
      method: 'GET',
      url: `/seo?url=${encodeURIComponent('https://www.guvi.in/zen-class/devops-course')}`,
    });
    expect(loose.json()).toEqual({ checks: [] });
  });

  it('400s with INVALID_PARAMS on a bad strategy', async () => {
    const response = await app.inject({ method: 'GET', url: '/seo?strategy=tablet' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_PARAMS');
  });

  it('keeps SEO checks out of GET /reports', async () => {
    await seed();
    const runs = [0, 1, 2].map((i) => makeReport({ fetchTime: `r${i}` }));
    await saveReport(
      applyTargets(aggregateReports(runs, { reportId: '2026-11-21T10-00-00Z-mobile', runsRequested: 3 })),
      runs,
      dir,
    );
    const response = await app.inject({ method: 'GET', url: '/reports' });
    expect(response.statusCode).toBe(200);
    const listed = response.json().reports as Array<{ reportId: string }>;
    expect(listed.map((entry) => entry.reportId)).toEqual(['2026-11-21T10-00-00Z-mobile']);
    expect(listed.some((entry) => entry.reportId.endsWith('-seo'))).toBe(false);
    expect(await seoFiles()).toHaveLength(4);
  });
});
