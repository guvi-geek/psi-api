/**
 * Pure logic behind the SEO and more tab. No React here, so tests/web-seo.test.ts can
 * check it directly. The check itself is shaped by src/seo.ts; this only
 * decides how the web UI words and marks what is already there.
 */
import { lighthouseLabel } from '../../src/render';
import { CATEGORY_IDS, isCategoryId, type CategoryId } from '../../src/categories';
import type { SeoAuditState, SeoCell, SeoCheck, SeoCounts, SeoSection } from '../../src/seo';
import { parseDescription, type Inline } from './findings';
import { formatWhen, scoreBand } from './run';

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

/** The category to open from the page URL; the first one when the URL names none or an unknown one. */
export function chosenCategory(value: string | null): CategoryId {
  return value && isCategoryId(value) ? value : CATEGORY_IDS[0];
}

/** Lighthouse colour bands; no colour when the category could not be scored. */
export function seoScoreTone(score: number | null): Tone {
  return score === null ? 'neutral' : scoreBand(score);
}

/** The state mark beside each audit, and the word screen readers hear for it. */
export function auditMark(state: SeoAuditState): { mark: string; tone: Tone; label: string } {
  switch (state) {
    case 'failed':
      return { mark: '✕', tone: 'bad', label: 'Failed' };
    case 'passed':
      return { mark: '✓', tone: 'good', label: 'Passed' };
    case 'error':
      return { mark: '!', tone: 'warn', label: 'Could not run' };
    case 'manual':
      return { mark: '○', tone: 'neutral', label: 'Check manually' };
    case 'notApplicable':
      return { mark: '–', tone: 'neutral', label: 'Not applicable' };
  }
}

/** Problems are shown open; what passed or does not apply stays folded, as on the website. */
export function sectionOpen(state: SeoAuditState): boolean {
  return state === 'failed' || state === 'error' || state === 'manual';
}

/** An audit's own details open by default only when something is wrong with it. */
export function auditOpen(state: SeoAuditState): boolean {
  return state === 'failed' || state === 'error';
}

/** The tone a section's heading takes. */
export function sectionTone(section: Pick<SeoSection, 'state'>): Tone {
  return auditMark(section.state).tone;
}

/** The header counts, in the website's order. Errors only when there are any. */
export function countItems(counts: SeoCounts): Array<{ key: keyof SeoCounts; label: string; value: number; tone: Tone }> {
  const items: Array<{ key: keyof SeoCounts; label: string; value: number; tone: Tone }> = [];
  if (counts.error > 0) items.push({ key: 'error', label: 'could not run', value: counts.error, tone: 'warn' });
  items.push(
    { key: 'failed', label: 'failed', value: counts.failed, tone: counts.failed > 0 ? 'bad' : 'neutral' },
    { key: 'manual', label: 'to check manually', value: counts.manual, tone: 'neutral' },
    { key: 'passed', label: 'passed', value: counts.passed, tone: counts.passed > 0 ? 'good' : 'neutral' },
    { key: 'notApplicable', label: 'not applicable', value: counts.notApplicable, tone: 'neutral' },
  );
  return items;
}

/** One line for the header: "0 failed, 1 to check manually, 10 passed, 0 not applicable". */
export function summaryText(counts: SeoCounts): string {
  return countItems(counts)
    .map((item) => `${item.value} ${item.label}`)
    .join(', ');
}

/** "Mobile, Lighthouse 13.0.1": the device and the engine that judged the page. */
export function checkedWith(check: Pick<SeoCheck, 'strategy' | 'lighthouseVersion'>): string {
  return `${check.strategy === 'mobile' ? 'Mobile' : 'Desktop'}, ${lighthouseLabel(check.lighthouseVersion)}`;
}

/** When the page was loaded, as the rest of the UI words it, to follow "checked". */
export function checkedWhen(fetchedAt: string, now = Date.now()): string {
  const when = formatWhen(fetchedAt, now);
  if (!when) return 'at an unknown time';
  return when === 'Just now' ? 'just now' : when;
}

/** The final address, only when the page redirected somewhere else. */
export function redirectedTo(check: Pick<SeoCheck, 'url' | 'finalUrl'>): string | null {
  const strip = (value: string) => value.replace(/\/+$/, '');
  return check.finalUrl && strip(check.finalUrl) !== strip(check.url) ? check.finalUrl : null;
}

/**
 * Audit titles carry `code` (e.g. Document has a `<title>` element). Only the
 * code is kept as code: a title is never a link, so links read as their text.
 */
export function titleParts(title: string): Array<{ text: string } | { code: string }> {
  return parseDescription(title).map((part: Inline) => ('link' in part ? { text: part.link } : part));
}

/** Only http(s) addresses may become links. */
export function safeHref(url: string): string | null {
  return /^https?:\/\//i.test(url.trim()) ? url.trim() : null;
}

export type CellView =
  | { kind: 'empty' }
  | { kind: 'text'; text: string }
  | { kind: 'number'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'node'; snippet: string; selector: string; label: string };

/**
 * How one table cell is shown. URLs and links become external links only when
 * they are http(s); anything else is shown as plain mono text, never as markup.
 */
export function cellView(cell: SeoCell | undefined): CellView {
  if (!cell) return { kind: 'empty' };
  switch (cell.kind) {
    case 'text':
      return { kind: 'text', text: cell.text };
    case 'number':
      return { kind: 'number', text: cell.value.toLocaleString('en-US') };
    case 'code':
      return { kind: 'code', text: cell.text };
    case 'url': {
      const href = safeHref(cell.url);
      return href ? { kind: 'link', text: cell.url, href } : { kind: 'code', text: cell.url };
    }
    case 'link': {
      const href = safeHref(cell.url);
      const text = cell.text || cell.url;
      return href ? { kind: 'link', text, href } : { kind: 'text', text };
    }
    case 'node':
      // The snippet is the element itself; with no snippet, Lighthouse's label stands in.
      return { kind: 'node', snippet: cell.snippet || cell.label, selector: cell.selector, label: cell.label };
  }
}

/** Numbers read right-aligned, like every other table in the UI. */
export function isNumericHeading(valueType: string): boolean {
  return ['numeric', 'number', 'bytes', 'ms', 'timespanMs'].includes(valueType);
}
