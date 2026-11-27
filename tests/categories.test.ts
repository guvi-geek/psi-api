/**
 * One call reads every category. The performance report must come out exactly
 * as a performance-only call made it; the other categories are read as the PSI
 * website shows them.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { categoriesOf, CATEGORY_IDS, performanceView } from '../src/categories.js';
import { normalizeReport } from '../src/insights.js';
import { seoSections } from '../src/seo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ALL = JSON.parse(readFileSync(path.join(here, 'fixtures', 'raw-all-categories-real.json'), 'utf8'));
const URL_ = 'https://www.guvi.in/zen-class/';

/** The same response as a performance-only call would return it, built by hand. */
function performanceOnly(raw: typeof ALL) {
  const copy = JSON.parse(JSON.stringify(raw));
  const lh = copy.lighthouseResult;
  const perf = new Set(lh.categories.performance.auditRefs.map((ref: { id: string }) => ref.id));
  for (const id of Object.keys(lh.categories)) {
    if (id === 'performance') continue;
    for (const ref of lh.categories[id].auditRefs) if (!perf.has(ref.id)) delete lh.audits[ref.id];
    delete lh.categories[id];
  }
  lh.configSettings.onlyCategories = ['performance'];
  return copy;
}

describe('performanceView', () => {
  it('normalises to exactly the performance-only report', () => {
    const fromAll = normalizeReport(performanceView(ALL), URL_, 'mobile');
    const fromPerf = normalizeReport(performanceOnly(ALL), URL_, 'mobile');
    expect(fromAll).toEqual(fromPerf);
    expect(fromAll.environment.categories).toEqual(['performance']);
    // Without the view, the other categories' audits would become findings.
    expect(normalizeReport(ALL, URL_, 'mobile').insights.length).toBeGreaterThan(fromAll.insights.length);
  });

  it('leaves a performance-only response untouched', () => {
    const perf = performanceOnly(ALL);
    expect(performanceView(perf)).toBe(perf);
    expect(performanceView(null)).toBeNull();
  });

  it('does not change the response it was given', () => {
    const before = JSON.stringify(ALL);
    performanceView(ALL);
    expect(JSON.stringify(ALL)).toBe(before);
  });
});

describe('categoriesOf', () => {
  const categories = categoriesOf(ALL, { url: URL_, strategy: 'mobile' });

  it('reads every category PSI returned, with its score', () => {
    expect(Object.keys(categories)).toEqual([...CATEGORY_IDS]);
    expect(Object.fromEntries(Object.entries(categories).map(([id, check]) => [id, check!.score]))).toEqual({
      accessibility: 97,
      'best-practices': 96,
      seo: 100,
      'agentic-browsing': 100,
    });
  });

  it('groups accessibility the way the website does, without the hidden group', () => {
    const a11y = categories.accessibility!;
    expect(a11y.title).toBe('Accessibility');
    expect(a11y.groups.map((group) => group.id)).not.toContain('hidden');
    // label-content-name-mismatch also fails, but it is in Lighthouse's hidden group, which the website skips.
    expect(a11y.counts.failed).toBe(1);
    expect(a11y.counts.manual).toBe(10);
    const failed = seoSections(a11y).filter((section) => section.state === 'failed');
    expect(failed.map((section) => [section.title, section.audits.map((audit) => audit.id)])).toEqual([['Contrast', ['color-contrast']]]);
    expect(failed[0]!.audits[0]!.table!.rows.length).toBeGreaterThan(0);
  });

  it('reads agentic browsing, including its ungrouped audit', () => {
    const agentic = categories['agentic-browsing']!;
    expect(agentic.title).toBe('Agentic Browsing');
    expect(agentic.audits.map((audit) => audit.id)).toContain('llms-txt');
    expect(agentic.counts.notApplicable).toBe(4);
  });

  it('leaves out a category the response does not have', () => {
    expect(categoriesOf(performanceOnly(ALL), { url: URL_, strategy: 'mobile' })).toEqual({});
  });
});
