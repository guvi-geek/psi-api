'use client';

import { Fragment, useEffect, useState, type ReactNode } from 'react';
import type { AggregatedReport } from '../../src/types';
import { seoSections, type SeoAudit, type SeoCell, type SeoCheck, type SeoSection, type SeoSummary, type SeoTable } from '../../src/seo';
import { api, ApiError } from './api';
import { parseDescription } from './findings';
import {
  auditMark,
  auditOpen,
  cellView,
  CHECK_TITLE,
  checkedWhen,
  checkedWith,
  checkRequest,
  countItems,
  isNumericHeading,
  newestCheckId,
  redirectedTo,
  sectionOpen,
  seoScoreTone,
  titleParts,
} from './seo-ui';

type Loaded = { state: 'loading' } | { state: 'empty' } | { state: 'ready'; check: SeoCheck } | { state: 'failed'; error: ApiError };

/**
 * The SEO section of the PageSpeed Insights website for this report's page.
 * An SEO check is its own PSI call, saved apart from the performance runs.
 */
export function SeoView({ report }: { report: AggregatedReport }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  // The newest saved check for this page and device. Reading it costs no quota.
  useEffect(() => {
    let live = true;
    setLoaded({ state: 'loading' });
    const query = new URLSearchParams({ url: report.url, strategy: report.strategy });
    api<{ checks: SeoSummary[] }>(`/seo?${query}`)
      .then(async (list) => {
        const id = newestCheckId(list);
        if (!id) return live && setLoaded({ state: 'empty' });
        const check = await api<SeoCheck>(`/seo/${encodeURIComponent(id)}`);
        return live && setLoaded({ state: 'ready', check });
      })
      .catch((error: ApiError) => live && setLoaded({ state: 'failed', error }));
    return () => {
      live = false;
    };
  }, [report.url, report.strategy]);

  // One PSI call with the SEO category. Saved, so the tab opens on it next time.
  async function runCheck() {
    setCheckError(null);
    setChecking(true);
    try {
      const { check } = await api<{ check: SeoCheck; saved: boolean }>('/seo', {
        method: 'POST',
        body: JSON.stringify(checkRequest(report)),
      });
      setLoaded({ state: 'ready', check });
    } catch (caught) {
      setCheckError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      setChecking(false);
    }
  }

  const button = (label: string, primary: boolean) => (
    <button
      type="button"
      className={`button ${primary ? 'button-primary' : 'button-quiet'}`}
      onClick={runCheck}
      disabled={checking}
      title={CHECK_TITLE}
    >
      {checking ? 'Checking' : label}
    </button>
  );
  const error = checkError && (
    <p className="form-error" role="alert">
      {checkError}
    </p>
  );

  if (loaded.state === 'loading') {
    return (
      <div className="panel" aria-busy="true">
        <p className="muted seo-flush">Looking for a saved SEO check of this page.</p>
      </div>
    );
  }

  if (loaded.state === 'empty' || loaded.state === 'failed') {
    return (
      <div className="stack">
        <div className="panel empty seo-empty">
          <h2 className="panel-title seo-flush">No SEO check of this page yet</h2>
          <p className="muted seo-flush">
            An SEO check asks PageSpeed Insights for its SEO category only: whether search engines can crawl and index
            the page, and whether its title, description, links and images are written for them. It is one PSI call, saved
            on its own and separate from the performance runs, so it does not change this report.
          </p>
          {loaded.state === 'failed' && (
            <p className="note-warn seo-flush">Could not read the saved SEO checks: {loaded.error.message}</p>
          )}
          <div className="seo-empty-actions">
            {button('Check SEO', true)}
            <span className="muted seo-flush">
              {report.strategy === 'mobile' ? 'Mobile' : 'Desktop'}, about 15 seconds
            </span>
          </div>
          {error}
        </div>
      </div>
    );
  }

  const { check } = loaded;
  return (
    <div className="stack">
      <SeoHeader check={check} action={button('Check again', false)} error={error} />
      {seoSections(check).map((section) => (
        <SeoSectionBlock key={`${section.state}-${section.groupId ?? section.title}`} section={section} />
      ))}
      <p className="note seo-flush">
        Like the PageSpeed Insights website: the score counts only weighted audits, and the checks under Additional
        items are never scored. Every check is saved under data/, apart from the performance reports.
      </p>
    </div>
  );
}

function SeoHeader({ check, action, error }: { check: SeoCheck; action: ReactNode; error: ReactNode }) {
  const tone = seoScoreTone(check.score);
  const redirect = redirectedTo(check);
  return (
    <div className="panel seo-header">
      <div className="seo-score">
        <span className={`score-value ${tone === 'neutral' ? 'muted-cell' : `text-${tone}`}`}>{check.score ?? '—'}</span>
        <span className="score-of">/ 100</span>
      </div>
      <div className="seo-heading">
        <h2 className="panel-title seo-flush">{check.title}</h2>
        <p className="report-sub">
          {checkedWith(check)}, checked{' '}
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
        {error}
      </div>
      <div className="seo-actions">{action}</div>
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
