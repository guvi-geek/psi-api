/**
 * Every run asks PSI for all of its categories in the same call, so one run
 * measures performance and reads accessibility, best practices, SEO and agentic
 * browsing at no extra quota. The performance report is built from a
 * performance-only view of that response, so it is exactly what a
 * performance-only call produced; the other categories are kept beside it.
 * No Node-only imports here: the web UI uses the same names.
 */
import { normalizeCategory, type CategoryCheck } from './seo.js';
import type { Strategy } from './types.js';

/** The categories a run reads besides performance, in the PSI website's order. */
export const CATEGORY_IDS = ['accessibility', 'best-practices', 'seo', 'agentic-browsing'] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];

/** How the API spells them in a request. */
export const PSI_CATEGORIES = ['PERFORMANCE', 'ACCESSIBILITY', 'BEST_PRACTICES', 'SEO', 'AGENTIC_BROWSING'];

export const CATEGORY_TITLES: Record<CategoryId, string> = {
  accessibility: 'Accessibility',
  'best-practices': 'Best practices',
  seo: 'SEO',
  'agentic-browsing': 'Agentic browsing',
};

/** What a report keeps from its median run: one check per category PSI returned. */
export type ReportCategories = Partial<Record<CategoryId, CategoryCheck>>;

export function isCategoryId(value: string): value is CategoryId {
  return (CATEGORY_IDS as readonly string[]).includes(value);
}

type Raw = Record<string, unknown>;
const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The response as a performance-only call returns it: the other categories, and
 * the audits only they use, removed. Audits performance shares with them, and
 * those no category references (network requests, screenshots), stay. A
 * response that has no other category comes back as it is.
 */
export function performanceView(raw: unknown): unknown {
  if (!isObject(raw) || !isObject(raw.lighthouseResult)) return raw;
  const categories = isObject(raw.lighthouseResult.categories) ? raw.lighthouseResult.categories : {};
  const others = Object.keys(categories).filter((id) => id !== 'performance');
  if (others.length === 0) return raw;

  const refsOf = (category: unknown): string[] =>
    isObject(category) && Array.isArray(category.auditRefs)
      ? category.auditRefs.filter(isObject).map((ref) => String(ref.id))
      : [];
  const performanceRefs = new Set(refsOf(categories.performance));
  const otherRefs = new Set(others.flatMap((id) => refsOf(categories[id])));

  const result = raw.lighthouseResult;
  const audits = isObject(result.audits) ? result.audits : {};
  const settings = isObject(result.configSettings) ? result.configSettings : null;
  return {
    ...raw,
    lighthouseResult: {
      ...result,
      categories: categories.performance === undefined ? {} : { performance: categories.performance },
      audits: Object.fromEntries(Object.entries(audits).filter(([id]) => performanceRefs.has(id) || !otherRefs.has(id))),
      ...(settings && Array.isArray(settings.onlyCategories)
        ? { configSettings: { ...settings, onlyCategories: settings.onlyCategories.filter((id) => id === 'performance') } }
        : {}),
    },
  };
}

/** Every non-performance category in a response. A category PSI did not return is left out. */
export function categoriesOf(raw: unknown, options: { url: string; strategy: Strategy }): ReportCategories {
  const result: ReportCategories = {};
  for (const id of CATEGORY_IDS) {
    try {
      result[id] = normalizeCategory(raw, id, options);
    } catch {
      /* not in this response */
    }
  }
  return result;
}
