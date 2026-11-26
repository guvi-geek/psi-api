/**
 * The Findings tab: the CLI's insight filters as state, the CLI's table row,
 * and the CLI's --items text for one insight. Filtering itself runs on the
 * server (GET /report/:id/insights → filterInsights), the same code the CLI
 * runs. No React here: tests import it.
 */
import type { AggregatedInsight, ScreenEmulation } from '../../src/types';
import { formatBytes, savingsLabel } from '../../src/render';
import { renderInsightRows } from '../../src/rows';
import { METRIC_SHORT } from './overview';

export const SORT_FIELDS = ['savingsMs', 'savingsBytes', 'score', 'firstPartyShare'] as const;

export type SortField = (typeof SORT_FIELDS)[number];

/** The CLI insight filters the tab offers. */
export interface Filters {
  search: string;
  party: 'any' | 'first' | 'third';
  sortBy: SortField;
  order: 'asc' | 'desc';
  /** --noFlaky */
  noFlaky: boolean;
}

export const DEFAULT_FILTERS: Filters = {
  search: '',
  party: 'any',
  sortBy: 'savingsMs',
  order: 'desc',
  noFlaky: false,
};

/** Filters from the page URL (#/report/<id>?tab=findings&party=first…). Unknown values are dropped. */
export function filtersFromParams(params: URLSearchParams): Filters {
  const filters: Filters = { ...DEFAULT_FILTERS };
  filters.search = params.get('search') ?? '';
  const party = params.get('party');
  if (party === 'first' || party === 'third') filters.party = party;
  const sortBy = params.get('sortBy');
  if (sortBy && (SORT_FIELDS as readonly string[]).includes(sortBy)) filters.sortBy = sortBy as SortField;
  if (params.get('order') === 'asc') filters.order = 'asc';
  filters.noFlaky = params.get('noFlaky') === '1';
  return filters;
}

/** The page URL's form of the filters: only what differs from the defaults. */
export function filtersToParams(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.search.trim()) params.set('search', filters.search.trim());
  if (filters.party !== 'any') params.set('party', filters.party);
  if (filters.sortBy !== 'savingsMs') params.set('sortBy', filters.sortBy);
  if (filters.order !== 'desc') params.set('order', filters.order);
  if (filters.noFlaky) params.set('noFlaky', '1');
  return params;
}

/** The server's query for GET /report/:id/insights. */
export function filtersToApiQuery(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.search.trim()) params.set('search', filters.search.trim());
  params.set('party', filters.party);
  params.set('sortBy', filters.sortBy);
  params.set('order', filters.order);
  params.set('includeFlaky', String(!filters.noFlaky));
  return params.toString();
}

/** The same view as a terminal command, with only the flags that change it. */
export function filtersToCli(reportId: string, filters: Filters): string {
  const args = ['npm run psi --', `--reportId ${reportId}`];
  if (filters.search.trim()) args.push(`--search "${filters.search.trim().replace(/"/g, '\\"')}"`);
  if (filters.party !== 'any') args.push(`--party ${filters.party}`);
  if (filters.sortBy !== 'savingsMs') args.push(`--sortBy ${filters.sortBy}`);
  if (filters.order !== 'desc') args.push(`--order ${filters.order}`);
  if (filters.noFlaky) args.push('--noFlaky');
  return args.join(' ');
}

/** How many filters are set, for the "Clear" control. Sorting is not a filter. */
export function activeFilterCount(filters: Filters): number {
  let count = 0;
  if (filters.search.trim()) count += 1;
  if (filters.party !== 'any') count += 1;
  if (filters.noFlaky) count += 1;
  return count;
}

/* ------------------------------- table rows ------------------------------- */

export interface FindingRow {
  id: string;
  title: string;
  group: string;
  /** The CLI's EST. SAVING: ms, else bytes, else — (no estimate, not zero). */
  saving: string;
  hasSaving: boolean;
  affects: string;
  /** The CLI's OURS: share of the cost on the site's own hosts. */
  ours: string;
  oursTone: 'good' | 'warn' | 'dim' | 'none';
  seen: string;
  flaky: boolean;
}

export function findingRow(insight: AggregatedInsight): FindingRow {
  const saving = savingsLabel(insight.savingsMs, insight.savingsBytes);
  const share = insight.firstPartyShare;
  return {
    id: insight.id,
    title: insight.title,
    group: insight.group,
    saving,
    hasSaving: saving !== '—',
    affects: (insight.metricsAffected ?? []).map((metric) => METRIC_SHORT[metric] ?? metric).join(' ') || '—',
    ours: share === null || share === undefined ? '—' : `${Math.round(share * 100)}%`,
    oursTone: share === null || share === undefined ? 'none' : share === 0 ? 'dim' : share < 1 ? 'warn' : 'good',
    seen: `${insight.appearedInRuns}/${insight.runsSucceeded}`,
    flaky: insight.flaky,
  };
}

/* ------------------------------ one insight ------------------------------ */

/** The CLI's --items output for this insight, without colour. */
export function insightRowsText(insight: AggregatedInsight, screen?: ScreenEmulation, width = 110): string {
  return renderInsightRows(insight, { width, useColor: false, screen, limit: 200 }).join('\n');
}

export interface Fact {
  label: string;
  value: string;
}

/** The JSON-only fields of an insight, as label and value. */
export function insightFacts(insight: AggregatedInsight): Fact[] {
  const facts: Fact[] = [
    { label: 'Estimated saving', value: savingsLabel(insight.savingsMs, insight.savingsBytes) },
  ];
  if (insight.savingsMs !== null && insight.savingsBytes !== null && insight.savingsBytes > 0 && (insight.savingsMs ?? 0) > 0) {
    facts.push({ label: 'Bytes', value: formatBytes(insight.savingsBytes) });
  }
  if (insight.savingsSource) facts.push({ label: 'Saving read from', value: insight.savingsSource });
  if (insight.displayValue) facts.push({ label: 'Lighthouse says', value: insight.displayValue });
  facts.push({ label: 'Score', value: insight.score === null ? '—' : String(insight.score) });
  facts.push({ label: 'Group', value: insight.group });
  facts.push({ label: 'Seen in', value: `${insight.appearedInRuns} of ${insight.runsSucceeded} runs${insight.flaky ? ' (flaky)' : ''}` });
  facts.push({
    label: 'Rows',
    value: `${insight.firstPartyItems} first-party, ${insight.thirdPartyItems} third-party`,
  });
  if (insight.itemHosts.length) facts.push({ label: 'Hosts', value: insight.itemHosts.join(', ') });
  return facts;
}

/** Mean, median and mode of the insight's own score and savings across runs. */
export function insightStats(insight: AggregatedInsight): Array<{ name: string; mean: string; median: string; mode: string }> {
  const rows: Array<{ name: string; mean: string; median: string; mode: string }> = [];
  const triple = (name: string, values: { mean: number; median: number; mode: number } | null, format: (n: number) => string) => {
    if (values) rows.push({ name, mean: format(values.mean), median: format(values.median), mode: format(values.mode) });
  };
  triple('Score', insight.stats?.score ?? null, (n) => String(Math.round(n * 100) / 100));
  triple('Saving (ms)', insight.stats?.savingsMs ?? null, (n) => `${Math.round(n)}ms`);
  triple('Saving (bytes)', insight.stats?.savingsBytes ?? null, (n) => formatBytes(n));
  return rows;
}

export type Inline = { text: string } | { code: string } | { link: string; href: string };

/**
 * Lighthouse descriptions are a small markdown subset: [text](url) and `code`.
 * Split into pieces to render, never as HTML. Only http(s) links become links.
 */
export function parseDescription(text: string): Inline[] {
  const parts: Inline[] = [];
  const pattern = /\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`/g;
  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    if (match[3] !== undefined) parts.push({ code: match[3] });
    else if (/^https?:\/\//i.test(match[2]!)) parts.push({ link: match[1]!, href: match[2]! });
    else parts.push({ text: match[1]! });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
