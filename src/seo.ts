/**
 * The SEO check: one PSI call with `category=seo`, turned into the SEO section
 * of the PageSpeed Insights website (score, failed audits by group, manual
 * checks, passed, not applicable). It is separate from the performance reports:
 * its own PSI call, its own file under data/<host>/seo/, and nothing that reads
 * reports ever reads it.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runPsiCall, type PsiCallOptions } from './psiClient.js';
import { stripCacheBust } from './insights.js';
import { dataDirForHost, getDataDir } from './storage.js';
import type { Strategy } from './types.js';

/** Where an audit sits on the website. Errors are audits Lighthouse could not run. */
export type SeoAuditState = 'failed' | 'passed' | 'manual' | 'notApplicable' | 'error';

/** One cell of an audit's detail table, kept typed so each view can show it its own way. */
export type SeoCell =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'url'; url: string }
  | { kind: 'link'; text: string; url: string }
  | { kind: 'node'; label: string; snippet: string; selector: string }
  | { kind: 'number'; value: number };

export interface SeoHeading {
  key: string;
  label: string;
  valueType: string;
}

export interface SeoRow {
  /** Keyed by heading key. A missing key is an empty cell. */
  cells: Record<string, SeoCell>;
  /** Lighthouse sub-items (e.g. the related element of a failing image), keyed by the parent heading key. */
  subRows?: Array<Record<string, SeoCell>>;
}

export interface SeoTable {
  headings: SeoHeading[];
  rows: SeoRow[];
}

export interface SeoAudit {
  id: string;
  title: string;
  /** Lighthouse's markdown: [text](url) links and `code`. */
  description: string;
  state: SeoAuditState;
  /** 0–1 as Lighthouse gives it; null for manual, not applicable and errors. */
  score: number | null;
  scoreDisplayMode: string;
  /** Group id, e.g. "seo-crawl". Null for manual checks, which have no group. */
  group: string | null;
  /** The audit's weight in the SEO score. 0 means it does not count. */
  weight: number;
  displayValue?: string;
  explanation?: string;
  errorMessage?: string;
  warnings?: string[];
  /** The detail table; null when Lighthouse gave none or it has no rows. */
  table: SeoTable | null;
}

export interface SeoGroup {
  id: string;
  title: string;
  description: string;
}

export interface SeoCounts {
  failed: number;
  passed: number;
  manual: number;
  notApplicable: number;
  error: number;
}

export interface SeoCheck {
  /** `<iso time>-<strategy>-seo`, e.g. 2026-11-26T10-30-00Z-mobile-seo. */
  seoId: string;
  url: string;
  finalUrl: string;
  strategy: Strategy;
  /** Lighthouse's fetchTime: when the page was loaded. */
  fetchedAt: string;
  lighthouseVersion: string;
  /** 0–100, as the website shows it. Null when Lighthouse could not score the category. */
  score: number | null;
  /** The category's own title and description. */
  title: string;
  description: string;
  /** What the website shows above the manual checks. */
  manualDescription: string;
  /** The SEO groups, in Lighthouse's order. */
  groups: SeoGroup[];
  /** Every SEO audit, in the category's order. */
  audits: SeoAudit[];
  counts: SeoCounts;
  runWarnings: string[];
  environment: { networkUserAgent?: string; benchmarkIndex?: number };
}

/** A saved check, as a list shows it. */
export interface SeoSummary {
  seoId: string;
  host: string;
  url: string;
  strategy: Strategy;
  fetchedAt: string;
  score: number | null;
  counts: SeoCounts;
}

/** The website's order: failed by group, then manual, passed, not applicable. Errors come first. */
export interface SeoSection {
  state: SeoAuditState;
  /** "Crawling and Indexing" for a failed group, else the section title. */
  title: string;
  /** Group description for failed groups; the manual description for manual checks. */
  description?: string;
  groupId?: string;
  audits: SeoAudit[];
}

/* -------------------------------- parsing -------------------------------- */

const SEO_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-(mobile|desktop)-seo$/;

export function isSeoId(value: string): boolean {
  return SEO_ID.test(value);
}

export function makeSeoId(strategy: Strategy, date = new Date()): string {
  const iso = date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  return `${iso}-${strategy}-seo`;
}

type Raw = Record<string, unknown>;
const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const clean = (value: unknown): string => stripCacheBust(str(value));

function stateOf(mode: string, score: number | null): SeoAuditState {
  if (mode === 'manual') return 'manual';
  if (mode === 'notApplicable') return 'notApplicable';
  if (mode === 'error') return 'error';
  if (mode === 'informative') return 'passed';
  // Lighthouse's own pass mark for scored audits.
  return score !== null && score >= 0.9 ? 'passed' : 'failed';
}

/** One table value to a typed cell. Unknown shapes become text, never dropped silently. */
export function toCell(value: unknown, valueType?: string): SeoCell | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return { kind: 'number', value };
  if (typeof value === 'boolean') return { kind: 'text', text: String(value) };
  if (typeof value === 'string') {
    if (valueType === 'url') return { kind: 'url', url: stripCacheBust(value) };
    if (valueType === 'code') return { kind: 'code', text: value };
    return { kind: 'text', text: stripCacheBust(value) };
  }
  if (!isObject(value)) return { kind: 'text', text: JSON.stringify(value) };
  switch (value.type) {
    case 'node':
      return {
        kind: 'node',
        label: str(value.nodeLabel),
        snippet: str(value.snippet),
        selector: str(value.selector),
      };
    case 'url':
      return { kind: 'url', url: clean(value.value) };
    case 'link':
      return { kind: 'link', text: str(value.text), url: clean(value.url) };
    case 'code':
      return { kind: 'code', text: str(value.value) };
    case 'source-location': {
      const where = [clean(value.url), value.line, value.column].filter((part) => part !== undefined && part !== '').join(':');
      return { kind: 'url', url: where };
    }
    case 'numeric':
      return typeof value.value === 'number' ? { kind: 'number', value: value.value } : null;
    case 'text':
      return { kind: 'text', text: clean(value.value) };
    default:
      return { kind: 'text', text: JSON.stringify(value) };
  }
}

/** Lighthouse table or opportunity details to a SeoTable. A list of tables is merged. */
export function toTable(details: unknown): SeoTable | null {
  if (!isObject(details)) return null;
  if (details.type === 'list' && Array.isArray(details.items)) {
    const tables = details.items.map(toTable).filter((table): table is SeoTable => table !== null);
    if (tables.length === 0) return null;
    return { headings: tables[0]!.headings, rows: tables.flatMap((table) => table.rows) };
  }
  if (details.type !== 'table' && details.type !== 'opportunity') return null;
  const rawHeadings = Array.isArray(details.headings) ? details.headings.filter(isObject) : [];
  const headings: SeoHeading[] = rawHeadings
    .filter((heading) => typeof heading.key === 'string' && heading.key)
    .map((heading) => ({
      key: heading.key as string,
      label: str(heading.label) || str(heading.text) || (heading.key as string),
      valueType: str(heading.valueType) || str(heading.itemType) || 'text',
    }));
  const items = Array.isArray(details.items) ? details.items.filter(isObject) : [];
  if (headings.length === 0 || items.length === 0) return null;

  const rows: SeoRow[] = items.map((item) => {
    const cells: Record<string, SeoCell> = {};
    for (const heading of headings) {
      const cell = toCell(item[heading.key], heading.valueType);
      if (cell) cells[heading.key] = cell;
    }
    const row: SeoRow = { cells };
    const sub = isObject(item.subItems) && Array.isArray(item.subItems.items) ? item.subItems.items.filter(isObject) : [];
    if (sub.length) {
      row.subRows = sub.map((subItem) => {
        const subCells: Record<string, SeoCell> = {};
        rawHeadings.forEach((heading) => {
          const subHeading = isObject(heading.subItemsHeading) ? heading.subItemsHeading : null;
          if (!subHeading || typeof heading.key !== 'string' || typeof subHeading.key !== 'string') return;
          const cell = toCell(subItem[subHeading.key], str(subHeading.valueType) || str(heading.valueType));
          if (cell) subCells[heading.key] = cell;
        });
        return subCells;
      });
    }
    return row;
  });
  return { headings, rows };
}

const zeroCounts = (): SeoCounts => ({ failed: 0, passed: 0, manual: 0, notApplicable: 0, error: 0 });

/**
 * A raw PSI response (requested with category=seo) to an SeoCheck.
 * Throws when the response has no SEO category, as normalize does for performance.
 */
export function normalizeSeo(raw: unknown, options: { url: string; strategy: Strategy; seoId: string }): SeoCheck {
  const body = isObject(raw) ? raw : {};
  const result = isObject(body.lighthouseResult) ? body.lighthouseResult : null;
  if (!result) throw new Error('PSI response contained no lighthouseResult');
  const categories = isObject(result.categories) ? result.categories : {};
  const seo = isObject(categories.seo) ? categories.seo : null;
  if (!seo) throw new Error('PSI response contained no seo category (did you request category=seo?)');

  const audits = isObject(result.audits) ? result.audits : {};
  const refs = Array.isArray(seo.auditRefs) ? seo.auditRefs.filter(isObject) : [];
  const groupIds: string[] = [];
  const counts = zeroCounts();

  const seoAudits: SeoAudit[] = [];
  for (const ref of refs) {
    const id = str(ref.id);
    const audit = isObject(audits[id]) ? (audits[id] as Raw) : null;
    if (!id || !audit) continue;
    const group = str(ref.group) || null;
    if (group && !groupIds.includes(group)) groupIds.push(group);
    const mode = str(audit.scoreDisplayMode);
    const score = typeof audit.score === 'number' ? audit.score : null;
    const state = stateOf(mode, score);
    counts[state] += 1;
    const entry: SeoAudit = {
      id,
      title: str(audit.title),
      description: str(audit.description),
      state,
      score: state === 'manual' || state === 'notApplicable' || state === 'error' ? null : score,
      scoreDisplayMode: mode,
      group,
      weight: typeof ref.weight === 'number' ? ref.weight : 0,
      table: toTable(audit.details),
    };
    if (str(audit.displayValue)) entry.displayValue = str(audit.displayValue);
    if (str(audit.explanation)) entry.explanation = str(audit.explanation);
    if (str(audit.errorMessage)) entry.errorMessage = str(audit.errorMessage);
    if (Array.isArray(audit.warnings) && audit.warnings.length) entry.warnings = audit.warnings.map(String);
    seoAudits.push(entry);
  }

  const rawGroups = isObject(result.categoryGroups) ? result.categoryGroups : {};
  const groups: SeoGroup[] = groupIds.map((id) => {
    const group = isObject(rawGroups[id]) ? (rawGroups[id] as Raw) : {};
    return { id, title: str(group.title) || id, description: str(group.description) };
  });

  const environment = isObject(result.environment) ? result.environment : {};
  const categoryScore = typeof seo.score === 'number' ? Math.round(seo.score * 100) : null;
  return {
    seoId: options.seoId,
    url: options.url,
    finalUrl: clean(result.finalDisplayedUrl) || clean(result.finalUrl) || options.url,
    strategy: options.strategy,
    fetchedAt: str(result.fetchTime),
    lighthouseVersion: str(result.lighthouseVersion),
    score: categoryScore,
    title: str(seo.title) || 'SEO',
    description: str(seo.description),
    manualDescription: str(seo.manualDescription),
    groups,
    audits: seoAudits,
    counts,
    runWarnings: Array.isArray(result.runWarnings) ? result.runWarnings.map(String) : [],
    environment: {
      ...(str(environment.networkUserAgent) ? { networkUserAgent: str(environment.networkUserAgent) } : {}),
      ...(typeof environment.benchmarkIndex === 'number' ? { benchmarkIndex: environment.benchmarkIndex } : {}),
    },
  };
}

/** The check in the website's order, empty sections left out. */
export function seoSections(check: SeoCheck): SeoSection[] {
  const sections: SeoSection[] = [];
  const of = (state: SeoAuditState) => check.audits.filter((audit) => audit.state === state);
  const errors = of('error');
  if (errors.length) sections.push({ state: 'error', title: 'Could not run', audits: errors });
  const failed = of('failed');
  for (const group of check.groups) {
    const audits = failed.filter((audit) => audit.group === group.id);
    if (audits.length) sections.push({ state: 'failed', title: group.title, description: group.description, groupId: group.id, audits });
  }
  const ungrouped = failed.filter((audit) => !audit.group || !check.groups.some((group) => group.id === audit.group));
  if (ungrouped.length) sections.push({ state: 'failed', title: 'Other', audits: ungrouped });
  const manual = of('manual');
  if (manual.length) {
    sections.push({ state: 'manual', title: 'Additional items to manually check', description: check.manualDescription, audits: manual });
  }
  const passed = of('passed');
  if (passed.length) sections.push({ state: 'passed', title: 'Passed audits', audits: passed });
  const notApplicable = of('notApplicable');
  if (notApplicable.length) sections.push({ state: 'notApplicable', title: 'Not applicable', audits: notApplicable });
  return sections;
}

/** A cell as plain text, for the terminal and for search. */
export function cellText(cell: SeoCell | undefined): string {
  if (!cell) return '';
  switch (cell.kind) {
    case 'text':
    case 'code':
      return cell.text;
    case 'url':
      return cell.url;
    case 'link':
      return cell.url ? `${cell.text} (${cell.url})` : cell.text;
    case 'node':
      return cell.label || cell.snippet || cell.selector;
    case 'number':
      return String(cell.value);
  }
}

/* --------------------------------- running -------------------------------- */

export type RunSeoOptions = Omit<PsiCallOptions, 'categories'> & { date?: Date };

/** One PSI call with category=seo. Costs one quota unit. */
export async function runSeoCheck(options: RunSeoOptions): Promise<SeoCheck> {
  const { date, ...call } = options;
  const strategy = call.strategy ?? 'mobile';
  const result = await runPsiCall({ ...call, strategy, categories: ['seo'] });
  return normalizeSeo(result.raw, { url: call.url, strategy, seoId: makeSeoId(strategy, date) });
}

/* --------------------------------- storage -------------------------------- */

const SEO_DIR = 'seo';

function assertSeoId(seoId: string): void {
  if (!isSeoId(seoId)) throw new Error(`invalid seoId: ${seoId}`);
}

/** data/<host>/seo/<seoId>.json. Reports live in data/<host>/<reportId>/, so the two never meet. */
export async function saveSeoCheck(check: SeoCheck, dataDir = getDataDir()): Promise<string> {
  assertSeoId(check.seoId);
  const dir = path.join(dataDirForHost(check.url, dataDir), SEO_DIR);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${check.seoId}.json`);
  await writeFile(file, `${JSON.stringify(check, null, 2)}\n`, 'utf8');
  return file;
}

async function hostsIn(dataDir: string): Promise<string[]> {
  try {
    return (await readdir(dataDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

export async function loadSeoCheck(seoId: string, dataDir = getDataDir()): Promise<SeoCheck | null> {
  assertSeoId(seoId);
  for (const host of await hostsIn(dataDir)) {
    try {
      return JSON.parse(await readFile(path.join(dataDir, host, SEO_DIR, `${seoId}.json`), 'utf8')) as SeoCheck;
    } catch {
      /* not here, keep looking */
    }
  }
  return null;
}

/** Saved checks, newest first. Filter by page and device to find the latest check of one page. */
export async function listSeoChecks(
  filter: { url?: string; strategy?: Strategy } = {},
  dataDir = getDataDir(),
): Promise<SeoSummary[]> {
  const found: SeoSummary[] = [];
  for (const host of await hostsIn(dataDir)) {
    let files: string[];
    try {
      files = (await readdir(path.join(dataDir, host, SEO_DIR))).filter((name) => isSeoId(name.replace(/\.json$/, '')));
    } catch {
      continue;
    }
    for (const name of files) {
      try {
        const check = JSON.parse(await readFile(path.join(dataDir, host, SEO_DIR, name), 'utf8')) as SeoCheck;
        if (filter.url && check.url !== filter.url) continue;
        if (filter.strategy && check.strategy !== filter.strategy) continue;
        found.push({
          seoId: check.seoId,
          host,
          url: check.url,
          strategy: check.strategy,
          fetchedAt: check.fetchedAt,
          score: check.score,
          counts: check.counts,
        });
      } catch {
        /* a broken file is skipped, as listReports skips a folder without a report */
      }
    }
  }
  return found.sort((a, b) => b.seoId.localeCompare(a.seoId));
}
