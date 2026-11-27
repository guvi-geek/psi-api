/**
 * The SEO check as terminal text. Pure: takes a check (or a list of saved
 * checks) and returns lines, so the CLI decides where they go and tests read
 * them directly. Colour and layout come from render.ts, so an SEO check looks
 * like the rest of the CLI.
 */
import { cellText, seoSections, type SeoAudit, type CategoryCheck, type SeoAuditState, type SeoCheck, type SeoSummary, type SeoTable } from './seo.js';
import {
  ABSENT,
  lighthouseLabel,
  paint,
  renderTable,
  shortenUrl,
  truncate,
  visibleLength,
  wrap,
  type CodeName,
  type Column,
} from './render.js';

export interface SeoViewOptions {
  /** Total width to fit, indent included. */
  width: number;
  useColor: boolean;
  /** The heading word: SEO, ACCESSIBILITY, ... Default SEO. */
  label?: string;
  /** The id that re-reads this view: a report id, or a saved check's seoId (the default). */
  id?: string;
  /** Most detail rows printed per audit. The rest are counted, and are in --json. */
  rowLimit?: number;
}

const INDENT = '  ';
/** Detail lines sit under the audit's id, past the symbol. */
const DETAIL_INDENT = '      ';
const GAP = 2;
const DEFAULT_ROW_LIMIT = 25;

const SYMBOLS: Record<SeoAuditState, { mark: string; color: CodeName }> = {
  error: { mark: '!', color: 'red' },
  failed: { mark: '✗', color: 'red' },
  manual: { mark: '?', color: 'cyan' },
  passed: { mark: '✓', color: 'green' },
  notApplicable: { mark: '–', color: 'dim' },
};

/** Lighthouse's own score bands, as the performance SCORE line uses them. */
function scoreColor(score: number): CodeName {
  return score >= 90 ? 'green' : score >= 50 ? 'yellow' : 'red';
}

/** `2026-11-26 10:00 UTC`, or the raw value when it is not a time. */
function when(iso: string): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return iso || ABSENT;
  const utc = new Date(iso).toISOString();
  return `${utc.slice(0, 10)} ${utc.slice(11, 16)} UTC`;
}

/** One line of a cell: snippets and labels can carry newlines, which would break a row. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function countsLine(check: Pick<SeoCheck, 'counts'>): string {
  const { counts } = check;
  const parts = [
    `${counts.passed} passed`,
    `${counts.failed} failed`,
    `${counts.manual} to check manually`,
    `${counts.notApplicable} not applicable`,
  ];
  if (counts.error > 0) parts.push(`${counts.error} could not run`);
  return parts.join(' · ');
}

function header(check: ViewCheck, options: SeoViewOptions): string[] {
  const { width, useColor } = options;
  const label = options.label ?? 'SEO';
  const id = options.id ?? check.seoId ?? '';
  const facts = [check.strategy, lighthouseLabel(check.lighthouseVersion), when(check.fetchedAt)].join(' · ');
  const withId = `${facts} · ${id}`;
  const lines = [
    `${paint('bold', label, useColor)}  ${paint('bold', shortenUrl(check.url, width - label.length - 2), useColor)}`,
    // The id is what re-reads this view, so it moves to its own line rather than being cut.
    ...(withId.length <= width ? [withId] : [truncate(facts, width), id]).map((line) => paint('dim', line, useColor)),
  ];
  if (check.finalUrl && check.finalUrl !== check.url) {
    lines.push(paint('dim', `landed on ${shortenUrl(check.finalUrl, width - 10)}`, useColor));
  }
  for (const warning of check.runWarnings) {
    for (const line of wrap(`warning: ${flat(warning)}`, width, INDENT)) lines.push(paint('yellow', line, useColor));
  }
  return lines;
}

/** The score, with the counts beside it, or under it when the line would not fit. */
function scoreLines(check: ViewCheck, options: SeoViewOptions): string[] {
  const { useColor, width } = options;
  const score = check.score === null ? paint('dim', ABSENT, useColor) : paint(scoreColor(check.score), String(check.score), useColor);
  const lead = `${paint('bold', 'SCORE', useColor)}    ${score} / 100`;
  const counts = countsLine(check);
  if (visibleLength(lead) + 3 + counts.length <= width) return [`${lead}   ${paint('dim', counts, useColor)}`];
  const under = ' '.repeat('SCORE    '.length);
  return [lead, ...wrap(counts, width - under.length, under).map((line, index) => paint('dim', index === 0 ? `${under}${line}` : line, useColor))];
}

/** The audit's own line: symbol, id, title, and the display value when Lighthouse gave one. */
function auditLine(audit: SeoAudit, idWidth: number, options: SeoViewOptions): string {
  const { useColor, width } = options;
  const symbol = SYMBOLS[audit.state];
  const id = audit.id.padEnd(idWidth);
  const value = audit.displayValue ? paint('dim', `   ${flat(audit.displayValue)}`, useColor) : '';
  const title = audit.state === 'passed' || audit.state === 'notApplicable' ? paint('dim', flat(audit.title), useColor) : flat(audit.title);
  return truncate(`${INDENT}${paint(symbol.color, symbol.mark, useColor)} ${id}  ${title}${value}`, width);
}

/** The column that gives way when a table is too wide: the first address or element, else the widest. */
function growIndex(table: SeoTable): number {
  const wide = table.headings.findIndex((heading) => ['url', 'node', 'link', 'source-location'].includes(heading.valueType));
  if (wide !== -1) return wide;
  let best = 0;
  let bestWidth = -1;
  table.headings.forEach((heading, index) => {
    const widest = table.rows.reduce((max, row) => Math.max(max, cellText(row.cells[heading.key]).length), 0);
    if (widest > bestWidth) {
      bestWidth = widest;
      best = index;
    }
  });
  return best;
}

/** The audit's detail table, sub-rows under their row, cut to the width like every other table. */
function tableLines(table: SeoTable, options: SeoViewOptions): string[] {
  const { useColor, width } = options;
  const limit = options.rowLimit ?? DEFAULT_ROW_LIMIT;
  const grow = growIndex(table);
  const columns: Column[] = table.headings.map((heading, index) => ({
    key: heading.key,
    label: heading.label,
    align: heading.valueType === 'numeric' || heading.valueType === 'bytes' || heading.valueType === 'ms' ? 'right' : 'left',
    min: Math.min(12, Math.max(3, heading.label.length)),
    ...(index === grow ? { grow: true, min: 16 } : {}),
  }));
  const rows: string[][] = [];
  for (const row of table.rows.slice(0, limit)) {
    rows.push(table.headings.map((heading) => flat(cellText(row.cells[heading.key]))));
    for (const sub of row.subRows ?? []) {
      rows.push(
        table.headings.map((heading, index) => {
          const text = flat(cellText(sub[heading.key]));
          const cell = index === 0 ? `└ ${text}` : text;
          return text || index === 0 ? paint('dim', cell, useColor) : '';
        }),
      );
    }
  }
  const lines = renderTable(columns, rows, {
    width,
    gap: GAP,
    indent: DETAIL_INDENT,
    styleLabel: (text) => paint('dim', text, useColor),
  });
  if (table.rows.length > limit) {
    lines.push(paint('dim', `${DETAIL_INDENT}… ${table.rows.length - limit} more row(s) in --json`, useColor));
  }
  return lines;
}

/** What a failed or errored audit carries beyond its title. */
function detailLines(audit: SeoAudit, options: SeoViewOptions): string[] {
  const { useColor, width } = options;
  const body = width - DETAIL_INDENT.length;
  const lines: string[] = [];
  const prose = (text: string, color: CodeName) => {
    for (const line of wrap(flat(text), body, '')) lines.push(paint(color, `${DETAIL_INDENT}${line}`, useColor));
  };
  if (audit.errorMessage) prose(`error: ${audit.errorMessage}`, 'red');
  if (audit.explanation) prose(audit.explanation, 'yellow');
  for (const warning of audit.warnings ?? []) prose(`warning: ${warning}`, 'yellow');
  if (audit.table) lines.push(...tableLines(audit.table, options));
  return lines;
}

function sectionHeading(title: string, audits: SeoAudit[], state: SeoAuditState, useColor: boolean): string {
  const count = state === 'failed' ? `${audits.length} failed` : String(audits.length);
  return `${paint('bold', title.toUpperCase(), useColor)}  ${paint(state === 'failed' || state === 'error' ? 'red' : 'dim', count, useColor)}`;
}

/** A check in the website's order: errors, failed audits by group, manual, passed, not applicable. */
/** A saved SEO check, or any category of a report (which has no seoId of its own). */
type ViewCheck = CategoryCheck & { seoId?: string };

export function renderSeoCheck(check: ViewCheck, options: SeoViewOptions): string[] {
  const { useColor } = options;
  const lines = [...header(check, options), '', ...scoreLines(check, options)];
  const sections = seoSections(check);
  const idWidth = check.audits.reduce((max, audit) => Math.max(max, audit.id.length), 0);
  for (const section of sections) {
    lines.push('', sectionHeading(section.title, section.audits, section.state, useColor));
    for (const audit of section.audits) {
      lines.push(auditLine(audit, idWidth, options));
      if (audit.state === 'failed' || audit.state === 'error') lines.push(...detailLines(audit, options));
    }
  }
  if (sections.length === 0) {
    lines.push('', paint('dim', `${INDENT}Lighthouse returned no ${options.label ?? 'SEO'} audits`, useColor));
  }
  return lines;
}

const LIST_COLUMNS: Column[] = [
  { key: 'id', label: 'SEO ID', min: 32 },
  { key: 'page', label: 'PAGE', min: 10, grow: true },
  { key: 'device', label: 'DEVICE', min: 7 },
  { key: 'score', label: 'SCORE', align: 'right', min: 5 },
  { key: 'failed', label: 'FAILED', align: 'right', min: 6 },
];

/** Saved checks, newest first, as `--seoList` prints them. */
export function renderSeoList(checks: SeoSummary[], options: SeoViewOptions): string[] {
  const { useColor, width } = options;
  const lines = [
    `${paint('bold', 'SEO CHECKS', useColor)}  ${paint('dim', `${checks.length} saved, newest first`, useColor)}`,
  ];
  if (checks.length === 0) {
    lines.push(paint('dim', `${INDENT}no saved SEO checks - run one with --seo <page>`, useColor));
    return lines;
  }
  const rows = checks.map((check) => [
    check.seoId,
    check.url,
    check.strategy,
    check.score === null ? paint('dim', ABSENT, useColor) : paint(scoreColor(check.score), String(check.score), useColor),
    paint(check.counts.failed > 0 ? 'red' : 'dim', String(check.counts.failed), useColor),
  ]);
  lines.push(
    ...renderTable(LIST_COLUMNS, rows, {
      width,
      gap: GAP,
      indent: INDENT,
      styleLabel: (text) => paint('dim', text, useColor),
    }),
  );
  return lines;
}
