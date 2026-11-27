'use client';

import { Fragment, useEffect, useState } from 'react';
import type { AggregatedReport } from '../../src/types';
import { CATEGORY_IDS, CATEGORY_TITLES, type CategoryId, type ReportCategories } from '../../src/categories';
import { seoSections, type CategoryCheck, type SeoAudit, type SeoCell, type SeoSection, type SeoTable } from '../../src/seo';
import { api, ApiError } from './api';
import { parseDescription } from './findings';
import { href } from './router';
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
  sectionOpen,
  seoScoreTone,
  titleParts,
} from './seo-ui';

type Loaded =
  | { state: 'loading' }
  | { state: 'missing' }
  | { state: 'ready'; categories: ReportCategories }
  | { state: 'failed'; error: ApiError };

/**
 * Accessibility, best practices, SEO and agentic browsing, as the PageSpeed
 * Insights website shows them. Every run reads them in the same PSI call as
 * its performance, so this costs nothing: it shows the report's median run.
 */
export function SeoView({ report, params }: { report: AggregatedReport; params: URLSearchParams }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [chosen, setChosen] = useState<CategoryId>(() => chosenCategory(params.get('category')));

  useEffect(() => {
    let live = true;
    setLoaded({ state: 'loading' });
    api<{ categories: ReportCategories | null }>(`/report/${encodeURIComponent(report.reportId)}/categories`)
      .then(({ categories }) => {
        if (!live) return;
        setLoaded(categories && Object.keys(categories).length > 0 ? { state: 'ready', categories } : { state: 'missing' });
      })
      .catch((error: ApiError) => live && setLoaded({ state: 'failed', error }));
    return () => {
      live = false;
    };
  }, [report.reportId]);

  // Keep the chosen category in the page URL, in place.
  useEffect(() => {
    const next = new URLSearchParams({ tab: 'seo' });
    if (chosen !== CATEGORY_IDS[0]) next.set('category', chosen);
    history.replaceState(null, '', href.report(report.reportId, next));
  }, [chosen, report.reportId]);

  if (loaded.state === 'loading') {
    return (
      <div className="panel" aria-busy="true">
        <p className="muted seo-flush">Reading this report&apos;s categories.</p>
      </div>
    );
  }

  if (loaded.state !== 'ready') {
    return (
      <div className="panel empty seo-empty">
        <h2 className="panel-title seo-flush">No SEO and more for this report</h2>
        <p className="muted seo-flush">
          It was measured before every run read accessibility, best practices, SEO and agentic browsing alongside
          performance. Measure again, at the top right, measures the page again with the same settings: it spends{' '}
          {report.runsRequested} PSI call{report.runsRequested === 1 ? '' : 's'}, and the new report has these categories with no
          extra calls on top.
        </p>
        {loaded.state === 'failed' && <p className="note-warn seo-flush">Could not read them: {loaded.error.message}</p>}
      </div>
    );
  }

  const { categories } = loaded;
  const available = CATEGORY_IDS.filter((id) => categories[id]);
  const current = categories[chosen] ? chosen : available[0]!;
  const check = categories[current]!;
  return (
    <div className="stack">
      <div className="category-strip" role="tablist" aria-label="Category">
        {available.map((id) => {
          const entry = categories[id]!;
          const tone = seoScoreTone(entry.score);
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={id === current}
              className="category-card"
              onClick={() => setChosen(id)}
            >
              <span className={`category-score ${tone === 'neutral' ? 'muted-cell' : `text-${tone}`}`}>{entry.score ?? '—'}</span>
              <span className="category-name">{CATEGORY_TITLES[id]}</span>
              <span className={`category-failed${entry.counts.failed > 0 ? ' text-bad' : ''}`}>
                {entry.counts.failed > 0 ? `${entry.counts.failed} failed` : 'none failed'}
              </span>
            </button>
          );
        })}
      </div>
      <CategoryHeader check={check} />
      {seoSections(check).map((section) => (
        <SeoSectionBlock key={`${current}-${section.state}-${section.groupId ?? section.title}`} section={section} />
      ))}
      <p className="note seo-flush">
        Read from this report&apos;s median run, in the same PSI calls as its performance. As on the PageSpeed Insights
        website, the score counts only weighted audits, and the items to check manually are never scored.
      </p>
    </div>
  );
}

function CategoryHeader({ check }: { check: CategoryCheck }) {
  const redirect = redirectedTo(check);
  return (
    <div className="panel seo-header">
      <div className="seo-heading">
        <h2 className="panel-title seo-flush">{check.title}</h2>
        <p className="report-sub">
          {checkedWith(check)}, measured{' '}
          <time dateTime={check.fetchedAt} title={new Date(check.fetchedAt).toLocaleString()}>
            {checkedWhen(check.fetchedAt)}
          </time>
        </p>
        <ul className="seo-counts">
          {countItems(check.counts).map((item) => (
            <li key={item.key} className={item.tone === 'neutral' ? undefined : `text-${item.tone}`}>
              <strong>{item.value}</strong> {item.label}
            </li>
          ))}
        </ul>
        {redirect && (
          <p className="note seo-redirect">
            Redirected to <span className="mono">{redirect}</span>
          </p>
        )}
        {check.runWarnings.length > 0 && (
          <ul className="alert-list seo-warnings">
            {check.runWarnings.map((warning) => (
              <li key={warning} className="text-warn">
                {warning}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Markdown({ text }: { text: string }) {
  return (
    <>
      {parseDescription(text).map((part, index) =>
        'link' in part ? (
          <a key={index} href={part.href} target="_blank" rel="noreferrer noopener">
            {part.link}
          </a>
        ) : 'code' in part ? (
          <code key={index}>{part.code}</code>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

function SeoSectionBlock({ section }: { section: SeoSection }) {
  const tone = auditMark(section.state).tone;
  return (
    <details className="panel seo-section" open={sectionOpen(section.state)}>
      <summary className="panel-title seo-section-title">
        <span className={tone === 'neutral' ? undefined : `text-${tone}`}>{section.title}</span>
        <span className="seo-section-count">{section.audits.length}</span>
      </summary>
      {section.description && (
        <p className="seo-section-description">
          <Markdown text={section.description} />
        </p>
      )}
      <ul className="seo-audits">
        {section.audits.map((audit) => (
          <li key={audit.id}>
            <AuditRow audit={audit} />
          </li>
        ))}
      </ul>
    </details>
  );
}

function AuditRow({ audit }: { audit: SeoAudit }) {
  const mark = auditMark(audit.state);
  return (
    <details className="seo-audit" open={auditOpen(audit.state)}>
      <summary className="seo-audit-summary">
        <span className={`seo-mark seo-mark-${mark.tone}`} aria-label={mark.label} role="img">
          {mark.mark}
        </span>
        <span className="seo-audit-title">
          {titleParts(audit.title).map((part, index) =>
            'code' in part ? <code key={index}>{part.code}</code> : <span key={index}>{part.text}</span>,
          )}
          {audit.displayValue && <span className="seo-display-value"> {audit.displayValue}</span>}
        </span>
        <span className="seo-audit-id mono">{audit.id}</span>
      </summary>
      <div className="seo-audit-body">
        {audit.description && (
          <p className="seo-audit-description">
            <Markdown text={audit.description} />
          </p>
        )}
        {audit.explanation && <p className="note-warn">{audit.explanation}</p>}
        {audit.errorMessage && <p className="note-warn">Lighthouse could not run this audit: {audit.errorMessage}</p>}
        {audit.warnings?.map((warning) => (
          <p key={warning} className="note-warn">
            {warning}
          </p>
        ))}
        {audit.table && <AuditTable table={audit.table} />}
      </div>
    </details>
  );
}

function AuditTable({ table }: { table: SeoTable }) {
  return (
    <div className="table-scroll seo-table-wrap">
      <table className="table seo-table">
        <thead>
          <tr>
            {table.headings.map((heading) => (
              <th key={heading.key} scope="col" className={isNumericHeading(heading.valueType) ? 'num' : undefined}>
                {heading.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, index) => (
            <Fragment key={index}>
              <tr className={row.subRows?.length ? 'has-sub' : undefined}>
                {table.headings.map((heading) => (
                  <td key={heading.key} className={isNumericHeading(heading.valueType) ? 'num' : undefined}>
                    <Cell cell={row.cells[heading.key]} />
                  </td>
                ))}
              </tr>
              {row.subRows?.map((sub, subIndex) => (
                <tr key={`${index}-${subIndex}`} className="seo-sub-row">
                  {table.headings.map((heading) => (
                    <td key={heading.key} className={isNumericHeading(heading.valueType) ? 'num' : undefined}>
                      <Cell cell={sub[heading.key]} />
                    </td>
                  ))}
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cell({ cell }: { cell: SeoCell | undefined }) {
  const view = cellView(cell);
  switch (view.kind) {
    case 'empty':
      return null;
    case 'text':
    case 'number':
      return <>{view.text}</>;
    case 'code':
      return <code className="seo-code">{view.text}</code>;
    case 'link':
      return (
        <a className="seo-link" href={view.href} target="_blank" rel="noreferrer noopener">
          {view.text}
        </a>
      );
    case 'node':
      return (
        <span className="seo-node" title={view.label || undefined}>
          <code className="seo-code">{view.snippet}</code>
          {view.selector && <span className="seo-selector mono">{view.selector}</span>}
        </span>
      );
  }
}
