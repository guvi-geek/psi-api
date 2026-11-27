/**
 * The SEO and more tab's logic, on the real PSI SEO response and on a broken copy of it:
 * the header words, the state marks, which sections and audits open, and which
 * table cells may become links.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeSeo, seoSections, type SeoAuditState } from '../src/seo.js';
import {
  auditMark,
  auditOpen,
  cellView,
  checkedWhen,
  checkedWith,
  chosenCategory,
  countItems,
  isNumericHeading,
  redirectedTo,
  safeHref,
  sectionOpen,
  seoScoreTone,
  summaryText,
  titleParts,
} from '../web/src/seo-ui.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RAW = JSON.parse(readFileSync(path.join(here, 'fixtures', 'raw-seo-real.json'), 'utf8')) as {
  lighthouseResult: { audits: Record<string, Record<string, unknown>>; categories: Record<string, unknown> };
};
const URL_ = 'https://www.guvi.in/zen-class/devops-course/';
const ID = '2026-11-26T10-00-00Z-mobile-seo';
const copy = () => JSON.parse(JSON.stringify(RAW)) as typeof RAW;

/** The same broken page tests/seo.test.ts builds: failures with tables, an error, a not-applicable audit. */
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
        { href: 'javascript:alert(1)', text: 'more' },
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

const passing = normalizeSeo(RAW, { url: URL_, strategy: 'mobile', seoId: ID });
const failing = normalizeSeo(failingRaw(), { url: URL_, strategy: 'desktop', seoId: ID });

describe('what the tab opens on', () => {
  it('opens the category the page URL names, or the first one', () => {
    expect(chosenCategory('seo')).toBe('seo');
    expect(chosenCategory('agentic-browsing')).toBe('agentic-browsing');
    expect(chosenCategory(null)).toBe('accessibility');
    expect(chosenCategory('performance')).toBe('accessibility');
    expect(chosenCategory('nope')).toBe('accessibility');
  });
});

describe('the header', () => {
  it('words the counts of a passing page in the website order', () => {
    expect(summaryText(passing.counts)).toBe('0 failed, 1 to check manually, 10 passed, 0 not applicable');
    expect(countItems(passing.counts).map((item) => [item.key, item.tone])).toEqual([
      ['failed', 'neutral'],
      ['manual', 'neutral'],
      ['passed', 'good'],
      ['notApplicable', 'neutral'],
    ]);
  });

  it('puts audits that could not run first, and colours failures', () => {
    expect(summaryText(failing.counts)).toBe('1 could not run, 3 failed, 1 to check manually, 5 passed, 1 not applicable');
    expect(countItems(failing.counts).slice(0, 2).map((item) => item.tone)).toEqual(['warn', 'bad']);
  });

  it('colours the score with the Lighthouse bands, and not at all when unscored', () => {
    expect(seoScoreTone(passing.score)).toBe('good');
    expect(seoScoreTone(failing.score)).toBe('warn');
    expect(seoScoreTone(49)).toBe('bad');
    expect(seoScoreTone(null)).toBe('neutral');
  });

  it('says which device and Lighthouse judged the page, and when', () => {
    expect(checkedWith(passing)).toBe(`Mobile, Lighthouse ${passing.lighthouseVersion}`);
    expect(checkedWith({ strategy: 'desktop', lighthouseVersion: '' })).toBe('Desktop, Lighthouse (version unknown)');
    const now = Date.parse(passing.fetchedAt);
    expect(checkedWhen(passing.fetchedAt, now)).toBe('just now');
    expect(checkedWhen(passing.fetchedAt, now + 3 * 3_600_000)).toBe('3 h ago');
    expect(checkedWhen('', now)).toBe('at an unknown time');
  });

  it('names the final address only when the page redirected', () => {
    expect(redirectedTo(passing)).toBeNull();
    expect(redirectedTo({ url: 'https://x.test/a', finalUrl: 'https://x.test/a/' })).toBeNull();
    expect(redirectedTo({ url: 'https://x.test/', finalUrl: 'https://www.x.test/' })).toBe('https://www.x.test/');
  });
});

describe('sections and audits', () => {
  it('marks each state with its sign and colour', () => {
    const states: SeoAuditState[] = ['failed', 'passed', 'manual', 'notApplicable', 'error'];
    expect(states.map((state) => [auditMark(state).mark, auditMark(state).tone])).toEqual([
      ['✕', 'bad'],
      ['✓', 'good'],
      ['○', 'neutral'],
      ['–', 'neutral'],
      ['!', 'warn'],
    ]);
  });

  it('opens problems and folds what passed or does not apply', () => {
    expect(seoSections(failing).map((section) => [section.state, sectionOpen(section.state)])).toEqual([
      ['error', true],
      ['failed', true],
      ['manual', true],
      ['passed', false],
      ['notApplicable', false],
    ]);
    expect(failing.audits.filter((audit) => auditOpen(audit.state)).map((audit) => audit.id)).toEqual([
      'meta-description',
      'link-text',
      'robots-txt',
      'image-alt',
    ]);
    // The real page: only the manual section is open, and its one item stays folded.
    const sections = seoSections(passing);
    expect(sections.map((section) => [section.title, sectionOpen(section.state)])).toEqual([
      ['Additional items to manually check', true],
      ['Passed audits', false],
    ]);
    expect(sections[0]!.description).toBe(passing.manualDescription);
    expect(passing.audits.some((audit) => auditOpen(audit.state))).toBe(false);
  });

  it('keeps code in titles as code, and never makes a title a link', () => {
    const title = passing.audits.find((audit) => audit.id === 'document-title')!.title;
    expect(titleParts(title)).toEqual([{ text: 'Document has a ' }, { code: '<title>' }, { text: ' element' }]);
    expect(titleParts('See [the docs](https://x.test/) for `alt`')).toEqual([
      { text: 'See ' },
      { text: 'the docs' },
      { text: ' for ' },
      { code: 'alt' },
    ]);
  });
});

describe('table cells', () => {
  it('links http(s) addresses only; anything else stays text', () => {
    const rows = failing.audits.find((audit) => audit.id === 'link-text')!.table!.rows;
    expect(cellView(rows[0]!.cells.href)).toEqual({ kind: 'link', text: 'https://www.guvi.in/a', href: 'https://www.guvi.in/a' });
    expect(cellView(rows[1]!.cells.href)).toEqual({ kind: 'code', text: 'javascript:alert(1)' });
    expect(cellView(rows[0]!.cells.text)).toEqual({ kind: 'text', text: 'click here' });
    expect(cellView({ kind: 'link', text: 'Docs', url: 'https://x.test/' })).toEqual({ kind: 'link', text: 'Docs', href: 'https://x.test/' });
    expect(cellView({ kind: 'link', text: 'Docs', url: 'data:text/html,x' })).toEqual({ kind: 'text', text: 'Docs' });
    expect(safeHref('HTTPS://x.test/')).toBe('HTTPS://x.test/');
    expect(safeHref('//x.test/')).toBeNull();
  });

  it('shows an element as its snippet with the selector, sub-rows included', () => {
    const row = failing.audits.find((audit) => audit.id === 'image-alt')!.table!.rows[0]!;
    expect(cellView(row.cells.node)).toEqual({ kind: 'node', snippet: '<img src="hero.png">', selector: 'div > img', label: 'hero' });
    expect(cellView(row.subRows![0]!.node)).toEqual({ kind: 'node', snippet: '<figure>', selector: 'figure', label: 'figure' });
    expect(cellView({ kind: 'node', label: 'hero', snippet: '', selector: '' })).toMatchObject({ snippet: 'hero' });
  });

  it('handles code, numbers and empty cells', () => {
    expect(cellView({ kind: 'code', text: 'Disallow: /' })).toEqual({ kind: 'code', text: 'Disallow: /' });
    expect(cellView({ kind: 'number', value: 12345 })).toEqual({ kind: 'number', text: '12,345' });
    expect(cellView(undefined)).toEqual({ kind: 'empty' });
    expect(isNumericHeading('numeric')).toBe(true);
    expect(isNumericHeading('url')).toBe(false);
  });
});
