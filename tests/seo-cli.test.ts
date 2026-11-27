/** The category flags on the CLI (--seo, --accessibility, --best-practices, --agentic): parsing, the text view, and their paths with a fake PSI; and --seoId / --seoList for older saved checks. */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { main, parseArgs } from '../src/cli.js';
import { normalizeSeo, type SeoCheck } from '../src/seo.js';
import { renderSeoCheck, renderSeoList } from '../src/seo-render.js';
import { saveSeoCheck } from '../src/seo-storage.js';
import { visibleLength } from '../src/render.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RAW = JSON.parse(readFileSync(path.join(here, 'fixtures', 'raw-seo-real.json'), 'utf8')) as {
  lighthouseResult: { audits: Record<string, Record<string, unknown>>; categories: Record<string, unknown> };
};
const URL_ = 'https://www.guvi.in/zen-class/devops-course/';
const ID = '2026-11-26T10-00-00Z-mobile-seo';

const copy = () => JSON.parse(JSON.stringify(RAW)) as typeof RAW;

/** The real response with failures, an error and a not-applicable audit, as in tests/seo.test.ts. */
function failingRaw() {
  const raw = copy();
  const audits = raw.lighthouseResult.audits;
  audits['meta-description'] = { ...audits['meta-description'], score: 0, title: 'Document does not have a meta description' };
  audits['link-text'] = {
    ...audits['link-text'],
    score: 0,
    displayValue: '2 links found',
    details: {
      type: 'table',
      headings: [
        { key: 'href', valueType: 'url', label: 'Link destination' },
        { key: 'text', valueType: 'text', label: 'Link Text' },
      ],
      items: [
        { href: 'https://www.guvi.in/a?psi_nonce=abc', text: 'click here' },
        { href: `https://www.guvi.in/b/${'a-very-long-path-segment/'.repeat(8)}`, text: 'more' },
      ],
    },
  };
  audits['image-alt'] = {
    ...audits['image-alt'],
    score: 0,
    details: {
      type: 'table',
      headings: [{ key: 'node', valueType: 'node', label: 'Failing Elements', subItemsHeading: { key: 'relatedNode', valueType: 'node' } }],
      items: [
        {
          node: { type: 'node', nodeLabel: 'hero', snippet: '<img src="hero.png">', selector: 'div > img' },
          subItems: { type: 'subitems', items: [{ relatedNode: { type: 'node', nodeLabel: 'figure', snippet: '<figure>', selector: 'figure' } }] },
        },
      ],
    },
  };
  audits['canonical'] = { ...audits['canonical'], score: 0, explanation: 'Multiple conflicting URLs', warnings: ['Points at another host'] };
  audits['hreflang'] = { ...audits['hreflang'], score: null, scoreDisplayMode: 'notApplicable' };
  audits['robots-txt'] = { ...audits['robots-txt'], score: null, scoreDisplayMode: 'error', errorMessage: 'Request timed out' };
  (raw.lighthouseResult.categories.seo as { score: number }).score = 0.62;
  return raw;
}

const passing = (): SeoCheck => normalizeSeo(RAW, { url: URL_, strategy: 'mobile', seoId: ID });
const failing = (): SeoCheck => normalizeSeo(failingRaw(), { url: URL_, strategy: 'desktop', seoId: '2026-11-26T10-00-00Z-desktop-seo' });

/** `fail()` exits the process; here it throws, so a usage error is an assertion, not a dead test runner. */
function trapExit() {
  const errors: string[] = [];
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    errors.push(String(chunk));
    return true;
  }) as never);
  return { errors, exit, stderr };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseArgs: the SEO flags', () => {
  it('reads --seo with a url, the device, --no-save and --json', () => {
    trapExit();
    expect(parseArgs([URL_, '--seo'])).toMatchObject({ seo: true, url: URL_, strategy: 'mobile', noSave: false, json: false });
    expect(parseArgs(['--seo', URL_, '--desktop', '--no-save', '--json'])).toMatchObject({
      seo: true,
      url: URL_,
      strategy: 'desktop',
      noSave: true,
      json: true,
    });
    expect(parseArgs([URL_, '--seo', '--strategy', 'desktop'])).toMatchObject({ strategy: 'desktop', category: 'seo' });
    expect(parseArgs([URL_, '--seo', '--runs', '3', '--stat', 'mean'])).toMatchObject({ runs: 3, stat: 'mean', category: 'seo' });
    expect(parseArgs([URL_, '--accessibility'])).toMatchObject({ category: 'accessibility', seo: false });
    expect(parseArgs(['--reportId', '2026-09-29T10-30-00Z-mobile', '--best-practices', '--json'])).toMatchObject({ category: 'best-practices', json: true });
    expect(parseArgs(['--reportId', '2026-09-29T10-30-00Z-mobile', '--agentic'])).toMatchObject({ category: 'agentic-browsing' });
  });

  it('reads --seoId and --seoList, with --json', () => {
    trapExit();
    expect(parseArgs(['--seoId', ID])).toMatchObject({ seoId: ID, seo: false, seoList: false });
    expect(parseArgs(['--seoId', ID, '--json'])).toMatchObject({ seoId: ID, json: true });
    expect(parseArgs(['--seoList'])).toMatchObject({ seoList: true });
    expect(parseArgs(['--seoList', '--json'])).toMatchObject({ seoList: true, json: true });
  });

  it('leaves the other modes unchanged', () => {
    trapExit();
    expect(parseArgs([URL_])).toMatchObject({ seo: false, seoId: undefined, seoList: false, url: URL_ });
    expect(parseArgs(['--list'])).toMatchObject({ list: true, seo: false, seoList: false });
  });

  const bad: Array<[string[], RegExp]> = [
    [[URL_, '--seo', '--seoList'], /--seo and --seoList are separate modes/],
    [['--seoId', ID, '--seoList'], /--seoId and --seoList are separate modes/],
    [[URL_, '--seo', '--reportId', '2026-09-29T10-30-00Z-mobile'], /--seo takes a url or --reportId, not both/],
    [[URL_, '--seo', '--accessibility'], /--seo and --accessibility are separate modes/],
    [['--reportId', '2026-09-29T10-30-00Z-mobile', '--agentic', '--desktop'], /--desktop cannot be combined with --agentic --reportId/],
    [[URL_, '--seo', '--list'], /--list cannot be combined with --seo/],
    [['--seoList', '--compare', 'a', 'b'], /--compare cannot be combined with --seoList/],
    [[URL_, '--seo', '--reanalyze'], /--reanalyze cannot be combined/],
    [[URL_, '--seo', '--diagnose'], /--diagnose cannot be combined/],
    [[URL_, '--seo', '--requests'], /--requests cannot be combined/],
    [[URL_, '--seo', '--items', 'a'], /--items cannot be combined/],
    [[URL_, '--seo', '--group', 'opportunity'], /--group cannot be combined/],
    [[URL_, '--seo', '--metric', 'lcp'], /--metric cannot be combined/],
    [['--seoId', ID, '--party', 'first'], /--party cannot be combined with --seoId/],
    [['--seoId', ID, '--desktop'], /--desktop cannot be combined with --seoId/],
    [['--seo'], /--seo needs a url to measure, or --reportId/],
    [[URL_, '--seoList'], /takes no url/],
    [['--seoId', 'not-an-id'], /--seoId expects an id like/],
    [['--seoId', '2026-11-26T10-00-00Z-mobile'], /--seoId expects an id like/],
    [['--seoId'], /--seoId requires a value/],
  ];
  it.each(bad)('rejects %j as a usage error', (argv, message) => {
    const { errors, exit } = trapExit();
    expect(() => parseArgs(argv)).toThrow('exit 1');
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.join('')).toMatch(message);
  });
});

describe('renderSeoCheck', () => {
  it('shows an all-passing check: score, counts, manual and passed sections, nothing failed', () => {
    const lines = renderSeoCheck(passing(), { width: 100, useColor: false });
    const text = lines.join('\n');
    expect(lines[0]).toBe(`SEO  ${URL_}`);
    expect(lines[1]).toMatch(/^mobile · Lighthouse \d+\.\d+\.\d+ · \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC · 2026-11-26T10-00-00Z-mobile-seo$/);
    expect(text).toContain('SCORE    100 / 100   10 passed · 0 failed · 1 to check manually · 0 not applicable');
    expect(text).toContain('ADDITIONAL ITEMS TO MANUALLY CHECK  1');
    expect(text).toContain('PASSED AUDITS  10');
    expect(text).toMatch(/^ {2}\? structured-data +Structured data is valid$/m);
    expect(text).toMatch(/^ {2}✓ document-title +Document has a `<title>` element$/m);
    expect(text).not.toContain('✗');
    expect(text).not.toContain('NOT APPLICABLE');
    expect(text).not.toContain('\u001b[');
  });

  it('shows failures by group with their tables, then manual, passed and not applicable', () => {
    const lines = renderSeoCheck(failing(), { width: 100, useColor: false });
    const text = lines.join('\n');
    const order = ['COULD NOT RUN  1', 'CONTENT BEST PRACTICES  4 failed', 'ADDITIONAL ITEMS TO MANUALLY CHECK  1', 'PASSED AUDITS  4', 'NOT APPLICABLE  1'];
    const at = order.map((heading) => lines.indexOf(heading));
    expect(at.every((index) => index > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);

    expect(text).toContain('SCORE    62 / 100   4 passed · 4 failed · 1 to check manually · 1 not applicable · 1 could not run');
    expect(text).toMatch(/^ {2}! robots-txt +robots\.txt is valid\n {6}error: Request timed out$/m);
    expect(text).toMatch(/^ {2}✗ meta-description +Document does not have a meta description$/m);
    expect(text).toMatch(/^ {2}✗ link-text +Links have descriptive text {3}2 links found$/m);
    expect(text).toMatch(/^ {6}Link destination +Link Text$/m);
    expect(text).toMatch(/^ {6}https:\/\/www\.guvi\.in\/a +click here$/m);
    // A long cell is cut with an ellipsis, as the other tables do, and its row keeps its other column.
    expect(text).toMatch(/^ {6}https:\/\/www\.guvi\.in\/b\/a-very-long[^\n]*… +more$/m);
    // The sub-row sits under its row.
    const hero = lines.findIndex((line) => line === '      hero');
    expect(hero).toBeGreaterThan(0);
    expect(lines[hero + 1]).toBe('      └ figure');
    expect(text).toMatch(/^ {6}Multiple conflicting URLs\n {6}warning: Points at another host$/m);
    expect(text).toMatch(/^ {2}– hreflang +/m);
    // Passed audits get one line each, no detail.
    const passedAt = lines.indexOf('PASSED AUDITS  4');
    expect(lines.slice(passedAt + 1, passedAt + 5).every((line) => line.startsWith('  ✓ '))).toBe(true);
    expect(text).not.toContain('psi_nonce');
  });

  it('keeps every line inside the width, and the id whole', () => {
    for (const width of [60, 80, 100]) {
      for (const check of [passing(), failing()]) {
        const lines = renderSeoCheck(check, { width, useColor: false });
        for (const line of lines) expect(visibleLength(line), `${width}: ${line}`).toBeLessThanOrEqual(width);
        expect(lines).toContainEqual(expect.stringContaining(check.seoId));
      }
    }
  });

  it('colours with the Lighthouse score bands only when asked', () => {
    const green = renderSeoCheck(passing(), { width: 100, useColor: true }).join('\n');
    expect(green).toContain('\u001b[32m100\u001b[0m');
    const yellow = renderSeoCheck(failing(), { width: 100, useColor: true }).join('\n');
    expect(yellow).toContain('\u001b[33m62\u001b[0m');
    expect(yellow).toContain('\u001b[31m✗\u001b[0m');
    const red = renderSeoCheck({ ...failing(), score: 30 }, { width: 100, useColor: true }).join('\n');
    expect(red).toContain('\u001b[31m30\u001b[0m');
    expect(renderSeoCheck(failing(), { width: 100, useColor: false }).join('\n')).not.toContain('\u001b[');
  });

  it('caps a long table and says where the rest is', () => {
    const check = failing();
    const links = check.audits.find((audit) => audit.id === 'link-text')!;
    links.table!.rows = Array.from({ length: 30 }, (_, index) => ({ cells: { text: { kind: 'text' as const, text: `row ${index}` } } }));
    const text = renderSeoCheck(check, { width: 100, useColor: false, rowLimit: 5 }).join('\n');
    expect(text).toContain('row 4');
    expect(text).not.toContain('row 5');
    expect(text).toContain('… 25 more row(s) in --json');
  });
});

describe('renderSeoList', () => {
  it('lists id, page, device, score and failed count, or says there are none', () => {
    const a = passing();
    const b = failing();
    const rows = [b, a].map((check) => ({
      seoId: check.seoId,
      host: 'www.guvi.in',
      url: check.url,
      strategy: check.strategy,
      fetchedAt: check.fetchedAt,
      score: check.score,
      counts: check.counts,
    }));
    const lines = renderSeoList(rows, { width: 120, useColor: false });
    expect(lines[0]).toBe('SEO CHECKS  2 saved, newest first');
    expect(lines[1]).toMatch(/^ {2}SEO ID +PAGE +DEVICE +SCORE +FAILED$/);
    expect(lines[2]).toMatch(new RegExp(`^  ${b.seoId} +${URL_} +desktop +62 +4$`));
    expect(lines[3]).toMatch(new RegExp(`^  ${a.seoId} +${URL_} +mobile +100 +0$`));
    expect(renderSeoList([], { width: 100, useColor: false })[1]).toMatch(/no saved SEO checks/);
  });
});

describe('the category views and the --seoId / --seoList paths', () => {
  let dir: string;
  let out: string[];
  let err: string[];
  let requests: string[];
  const saved: Record<string, string | undefined> = {};
  const ENV = ['PSI_DATA_DIR', 'PSI_API_KEY', 'NO_COLOR', 'FORCE_COLOR', 'COLUMNS'] as const;
  let exit: MockInstance;

  const fetchImpl = (async (input: string | URL) => {
    requests.push(String(input));
    return new Response(JSON.stringify(RAW), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const deps = { fetchImpl, sleepImpl: async () => {} };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'psi-api-seo-cli-'));
    for (const key of ENV) saved[key] = process.env[key];
    process.env.PSI_DATA_DIR = dir;
    process.env.PSI_API_KEY = 'test-key';
    process.env.NO_COLOR = '1';
    process.env.COLUMNS = '100';
    delete process.env.FORCE_COLOR;
    out = [];
    err = [];
    requests = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    }) as never);
    exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await rm(dir, { recursive: true, force: true });
  });

  const seoFiles = async () => {
    try {
      return await readdir(path.join(dir, 'www.guvi.in', 'seo'));
    } catch {
      return [];
    }
  };

  /** A PSI stand-in that answers with every category, one fresh analysis per call. */
  const ALL = JSON.parse(readFileSync(path.join(here, 'fixtures', 'raw-all-categories-real.json'), 'utf8'));
  let calls = 0;
  const allCategories = (performanceOnly = false) =>
    (async (input: string | URL) => {
      requests.push(String(input));
      const raw = JSON.parse(JSON.stringify(ALL));
      raw.lighthouseResult.fetchTime = `2026-11-27T10:00:${String(calls++ % 60).padStart(2, '0')}.000Z`;
      if (performanceOnly) {
        // As a run from before every call read all categories.
        for (const id of Object.keys(raw.lighthouseResult.categories)) if (id !== 'performance') delete raw.lighthouseResult.categories[id];
      }
      return new Response(JSON.stringify(raw), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  const all = () => ({ fetchImpl: allCategories(), sleepImpl: async () => {} });

  const reportIdIn = (text: string) => /saved as reportId (\S+)/.exec(text)?.[1] ?? '';

  it('--seo with a url measures as usual, reading every category, and shows the SEO view', async () => {
    expect(await main([URL_, '--seo', '--runs', '2', '--desktop'], all())).toBe(0);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const query = new URL(request).searchParams;
      expect(query.getAll('category')).toEqual(['PERFORMANCE', 'ACCESSIBILITY', 'BEST_PRACTICES', 'SEO', 'AGENTIC_BROWSING']);
      expect(query.get('strategy')).toBe('desktop');
    }
    const text = out.join('');
    const reportId = reportIdIn(text);
    expect(reportId).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-desktop-[0-9a-f]{6}$/);
    expect(text).toContain(`SEO  ${URL_}`);
    expect(text).toContain(`UTC · ${reportId}`);
    expect(text).toContain('SCORE    100 / 100');
    expect(text).toContain(`--reportId ${reportId} --seo re-reads it for free (no PSI call)`);
    // The performance report is saved as usual, its other categories beside it; no separate SEO check.
    expect((await readdir(path.join(dir, 'www.guvi.in', reportId))).sort()).toEqual(['categories.json', 'report.json', 'runs.json']);
    expect(await seoFiles()).toEqual([]);
    expect(err.join('')).toContain('desktop · 2 runs');
  });

  it('--accessibility, --best-practices and --agentic read a saved report for free', async () => {
    expect(await main([URL_, '--runs', '1'], all())).toBe(0);
    const reportId = reportIdIn(out.join(''));
    // The plain command still prints the performance report.
    expect(out.join('')).toContain('FINDINGS');
    const before = requests.length;

    out.length = 0;
    expect(await main(['--reportId', reportId, '--accessibility'], all())).toBe(0);
    const a11y = out.join('');
    expect(a11y).toContain(`ACCESSIBILITY  ${URL_}`);
    expect(a11y).toContain('SCORE    97 / 100');
    expect(a11y).toMatch(/CONTRAST {2}1 failed\n {2}✗ color-contrast/);
    expect(a11y).not.toContain('saved as reportId');

    out.length = 0;
    expect(await main(['--reportId', reportId, '--best-practices', '--json'], all())).toBe(0);
    expect(JSON.parse(out.join(''))).toMatchObject({ reportId, category: 'best-practices', title: 'Best Practices', score: 96 });

    out.length = 0;
    expect(await main(['--reportId', reportId, '--agentic'], all())).toBe(0);
    expect(out.join('')).toContain(`AGENTIC BROWSING  ${URL_}`);
    expect(out.join('')).toContain('✓ llms-txt');
    expect(requests).toHaveLength(before);
  });

  it('--seo --json --no-save prints the category and writes nothing', async () => {
    expect(await main([URL_, '--seo', '--json', '--no-save', '--runs', '1'], all())).toBe(0);
    expect(JSON.parse(out.join(''))).toMatchObject({ category: 'seo', url: URL_, score: 100, counts: { passed: 10, manual: 1 } });
    expect(await readdir(dir)).toEqual([]);
  });

  it('--seo --no-save in text says it was not saved', async () => {
    expect(await main([URL_, '--seo', '--no-save', '--runs', '1'], all())).toBe(0);
    expect(out.join('')).toContain('not saved (--no-save)');
    expect(await readdir(dir)).toEqual([]);
  });

  it('a report from before runs read every category says so', async () => {
    expect(await main([URL_, '--runs', '1'], { fetchImpl: allCategories(true), sleepImpl: async () => {} })).toBe(0);
    const reportId = reportIdIn(out.join(''));
    expect(await main(['--reportId', reportId, '--seo'], all())).toBe(1);
    expect(err.join('')).toContain(`error: report ${reportId} has no seo data`);
  });

  it('refuses a bad url before any call', async () => {
    expect(await main(['ftp://example.com/', '--seo'], all())).toBe(1);
    expect(err.join('')).toMatch(/error: unsupported protocol/);
    expect(requests).toHaveLength(0);
  });

  it('--seoId and --seoList still read SEO checks saved by the older --seo', async () => {
    const check = normalizeSeo(RAW, { url: URL_, strategy: 'desktop', seoId: '2026-11-26T10-00-00Z-desktop-seo' });
    await saveSeoCheck(check, dir);
    expect(await main(['--seoId', check.seoId, '--json'], deps)).toBe(0);
    expect(JSON.parse(out.join(''))).toMatchObject({ seoId: check.seoId, url: URL_, score: 100 });
    out.length = 0;
    expect(await main(['--seoId', check.seoId], deps)).toBe(0);
    expect(out.join('')).toContain(`SEO  ${URL_}`);
    expect(out.join('')).toContain(`UTC · ${check.seoId}`);
    out.length = 0;
    expect(await main(['--seoList'], deps)).toBe(0);
    expect(out.join('')).toMatch(new RegExp(`SEO CHECKS  1 saved, newest first[\\s\\S]*${check.seoId}`));
    expect(requests).toHaveLength(0);
  });

  it('an unknown --seoId is a clear error and exit 1, like a missing --reportId', async () => {
    expect(await main(['--seoId', '2020-01-01T00-00-00Z-mobile-seo'], deps)).toBe(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(err.join('')).toContain('error: no saved SEO check "2020-01-01T00-00-00Z-mobile-seo"');
    expect(requests).toHaveLength(0);
  });

  it('--seoList with nothing saved says so', async () => {
    expect(await main(['--seoList'], deps)).toBe(0);
    expect(out.join('')).toContain('no saved SEO checks');
    expect(await main(['--seoList', '--json'], deps)).toBe(0);
    expect(out.join('')).toContain('"checks": []');
  });
});
