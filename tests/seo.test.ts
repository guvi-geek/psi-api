/** The SEO check: a real PSI SEO response turned into the website's SEO section, and stored apart from reports. */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cellText,
  isSeoId,
  makeSeoId,
  normalizeSeo,
  seoSections,
  toCell,
  toTable,
  type SeoCheck,
} from '../src/seo.js';
import { listSeoChecks, loadSeoCheck, saveSeoCheck } from '../src/seo-storage.js';
import { listReports } from '../src/storage.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RAW = JSON.parse(readFileSync(path.join(here, 'fixtures', 'raw-seo-real.json'), 'utf8')) as {
  lighthouseResult: { audits: Record<string, Record<string, unknown>>; categories: Record<string, unknown> };
};
const URL_ = 'https://www.guvi.in/zen-class/devops-course/';
const ID = '2026-11-26T10-00-00Z-mobile-seo';

const copy = () => JSON.parse(JSON.stringify(RAW)) as typeof RAW;

/** The real response with failures, an error and a not-applicable audit, as a broken page would give. */
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
        { href: 'https://www.guvi.in/b', text: 'more' },
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
  audits['hreflang'] = { ...audits['hreflang'], score: null, scoreDisplayMode: 'notApplicable' };
  audits['robots-txt'] = { ...audits['robots-txt'], score: null, scoreDisplayMode: 'error', errorMessage: 'Request timed out' };
  (raw.lighthouseResult.categories.seo as { score: number }).score = 0.62;
  return raw;
}

describe('normalizeSeo on a real PSI response', () => {
  const check = normalizeSeo(RAW, { url: URL_, strategy: 'mobile', seoId: ID });

  it('reads the score and every audit in the category order', () => {
    expect(check.score).toBe(100);
    expect(check.title).toBe('SEO');
    expect(check.audits.map((audit) => audit.id)).toEqual([
      'is-crawlable',
      'document-title',
      'meta-description',
      'http-status-code',
      'link-text',
      'crawlable-anchors',
      'robots-txt',
      'image-alt',
      'hreflang',
      'canonical',
      'structured-data',
    ]);
    expect(check.counts).toEqual({ failed: 0, passed: 10, manual: 1, notApplicable: 0, error: 0 });
    expect(check.lighthouseVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('keeps the groups in Lighthouse order with their titles', () => {
    expect(check.groups.map((group) => group.id)).toEqual(['seo-crawl', 'seo-content']);
    expect(check.groups[0]).toMatchObject({ title: 'Crawling and Indexing' });
    expect(check.audits.find((audit) => audit.id === 'structured-data')).toMatchObject({ state: 'manual', group: null, score: null, weight: 0 });
  });

  it('drops the cache-busting nonce from the page address', () => {
    expect(check.finalUrl).toBe(URL_);
    expect(JSON.stringify(check)).not.toContain('psi_nonce');
  });

  it('leaves out tables with no rows, as the website does for passed audits', () => {
    expect(check.audits.every((audit) => audit.table === null)).toBe(true);
  });

  it('refuses a response without the SEO category', () => {
    const raw = copy();
    delete raw.lighthouseResult.categories.seo;
    expect(() => normalizeSeo(raw, { url: URL_, strategy: 'mobile', seoId: ID })).toThrow(/no seo category/);
    expect(() => normalizeSeo({}, { url: URL_, strategy: 'mobile', seoId: ID })).toThrow(/no lighthouseResult/);
  });
});

describe('a page with SEO problems', () => {
  const check = normalizeSeo(failingRaw(), { url: URL_, strategy: 'desktop', seoId: ID });

  it('sorts audits into failed, error, not applicable, manual and passed', () => {
    expect(check.score).toBe(62);
    expect(check.counts).toEqual({ failed: 3, passed: 5, manual: 1, notApplicable: 1, error: 1 });
    expect(check.audits.find((audit) => audit.id === 'robots-txt')).toMatchObject({ state: 'error', errorMessage: 'Request timed out', score: null });
  });

  it('lists sections in the website order, failures under their group', () => {
    expect(seoSections(check).map((section) => [section.state, section.title, section.audits.map((audit) => audit.id)])).toEqual([
      ['error', 'Could not run', ['robots-txt']],
      ['failed', 'Content Best Practices', ['meta-description', 'link-text', 'image-alt']],
      ['manual', 'Additional items to manually check', ['structured-data']],
      ['passed', 'Passed audits', ['is-crawlable', 'document-title', 'http-status-code', 'crawlable-anchors', 'canonical']],
      ['notApplicable', 'Not applicable', ['hreflang']],
    ]);
  });

  it('keeps the detail rows, typed, with sub-rows and without the nonce', () => {
    const links = check.audits.find((audit) => audit.id === 'link-text')!;
    expect(links.displayValue).toBe('2 links found');
    expect(links.table!.headings.map((heading) => heading.label)).toEqual(['Link destination', 'Link Text']);
    expect(links.table!.rows[0]!.cells).toEqual({
      href: { kind: 'url', url: 'https://www.guvi.in/a' },
      text: { kind: 'text', text: 'click here' },
    });
    const images = check.audits.find((audit) => audit.id === 'image-alt')!;
    expect(images.table!.rows[0]).toEqual({
      cells: { node: { kind: 'node', label: 'hero', snippet: '<img src="hero.png">', selector: 'div > img' } },
      subRows: [{ node: { kind: 'node', label: 'figure', snippet: '<figure>', selector: 'figure' } }],
    });
  });
});

describe('cells', () => {
  it('types every Lighthouse value kind and words it for the terminal', () => {
    expect(toCell({ type: 'link', text: 'Docs', url: 'https://x.test/?psi_nonce=1' })).toEqual({ kind: 'link', text: 'Docs', url: 'https://x.test/' });
    expect(toCell({ type: 'source-location', url: 'https://x.test/a.js', line: 3, column: 7 })).toEqual({ kind: 'url', url: 'https://x.test/a.js:3:7' });
    expect(toCell({ type: 'code', value: 'noindex' })).toEqual({ kind: 'code', text: 'noindex' });
    expect(toCell('Disallow: /', 'code')).toEqual({ kind: 'code', text: 'Disallow: /' });
    expect(toCell({ type: 'numeric', value: 4 })).toEqual({ kind: 'number', value: 4 });
    expect(toCell(null)).toBeNull();
    expect(cellText({ kind: 'node', label: '', snippet: '<a>', selector: 'a' })).toBe('<a>');
    expect(cellText({ kind: 'link', text: 'Docs', url: 'https://x.test/' })).toBe('Docs (https://x.test/)');
    expect(cellText(undefined)).toBe('');
  });

  it('merges a list of tables and ignores detail kinds it cannot show', () => {
    const table = { type: 'table', headings: [{ key: 'a', valueType: 'text', label: 'A' }], items: [{ a: 'x' }] };
    expect(toTable({ type: 'list', items: [table, table] })!.rows).toHaveLength(2);
    expect(toTable({ type: 'debugdata', items: [] })).toBeNull();
    expect(toTable(undefined)).toBeNull();
  });
});

describe('storage', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'psi-api-seo-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const at = (iso: string, strategy: 'mobile' | 'desktop', url = URL_): SeoCheck =>
    normalizeSeo(RAW, { url, strategy, seoId: makeSeoId(strategy, new Date(iso)) });

  it('saves under data/<host>/seo/, reads it back, and lists newest first', async () => {
    const older = at('2026-11-25T09:00:00.000Z', 'mobile');
    const newer = at('2026-11-26T09:00:00.000Z', 'mobile');
    const desktop = at('2026-11-26T08:00:00.000Z', 'desktop');
    const other = at('2026-11-26T07:00:00.000Z', 'mobile', 'https://www.guvi.in/');
    for (const check of [older, newer, desktop, other]) await saveSeoCheck(check, dir);

    expect(await readdir(path.join(dir, 'www.guvi.in', 'seo'))).toHaveLength(4);
    expect(await loadSeoCheck(newer.seoId, dir)).toEqual(newer);
    expect(await loadSeoCheck('2020-01-01T00-00-00Z-mobile-seo', dir)).toBeNull();

    const all = await listSeoChecks({}, dir);
    expect(all.map((entry) => entry.seoId)).toEqual([newer.seoId, desktop.seoId, other.seoId, older.seoId]);
    expect(all[0]).toMatchObject({ host: 'www.guvi.in', url: URL_, strategy: 'mobile', score: 100 });
    const page = await listSeoChecks({ url: URL_, strategy: 'mobile' }, dir);
    expect(page.map((entry) => entry.seoId)).toEqual([newer.seoId, older.seoId]);
  });

  it('never overwrites: a taken id, on this host or another, moves a second later', async () => {
    const first = at('2026-11-26T09:00:00.000Z', 'mobile');
    const second = at('2026-11-26T09:00:00.000Z', 'mobile', 'https://www.guvi.in/');
    const third = at('2026-11-26T09:00:00.000Z', 'mobile', 'https://other.test/');
    await saveSeoCheck(first, dir);
    await saveSeoCheck(second, dir);
    await saveSeoCheck(third, dir);
    expect([first.seoId, second.seoId, third.seoId]).toEqual([
      '2026-11-26T09-00-00Z-mobile-seo',
      '2026-11-26T09-00-01Z-mobile-seo',
      '2026-11-26T09-00-02Z-mobile-seo',
    ]);
    expect((await loadSeoCheck(first.seoId, dir))!.url).toBe(URL_);
    expect((await loadSeoCheck(second.seoId, dir))!.url).toBe('https://www.guvi.in/');
    expect((await loadSeoCheck(third.seoId, dir))!.url).toBe('https://other.test/');
  });

  it('is invisible to the report list, so no existing command sees it', async () => {
    await saveSeoCheck(at('2026-11-26T09:00:00.000Z', 'mobile'), dir);
    expect(await listReports(dir)).toEqual([]);
  });

  it('rejects ids that are not SEO check ids, so a path cannot be smuggled in', async () => {
    expect(isSeoId('2026-11-26T09-00-00Z-mobile-seo')).toBe(true);
    expect(isSeoId('2026-11-26T09-00-00Z-mobile')).toBe(false);
    expect(isSeoId('../../etc/passwd')).toBe(false);
    await expect(loadSeoCheck('../x', dir)).rejects.toThrow(/invalid seoId/);
    await expect(saveSeoCheck({ ...at('2026-11-26T09:00:00.000Z', 'mobile'), seoId: '../x' }, dir)).rejects.toThrow(/invalid seoId/);
  });
});
