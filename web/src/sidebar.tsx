'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { href } from './router';
import { formatWhen, groupReports, measuredAt, pathOf, reportsPath, scoreBand, type ReportRow } from './run';

type Page = { reports: ReportRow[]; next: string | null };

/**
 * The CLI's --list: stored reports by host, newest first, a page at a time.
 * The filter asks the server, so it finds reports that are not loaded yet.
 * Reading them costs no quota.
 */
export function Sidebar({ activeId, version }: { activeId?: string; version: number }) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [list, setList] = useState<{ reports: ReportRow[]; next: string | null } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  // The first page: again after each finished run (version) and for each search.
  useEffect(() => {
    let live = true;
    api<Page>(reportsPath({ q: search }))
      .then((page) => {
        if (!live) return;
        setList({ reports: page.reports, next: page.next });
        setError(null);
      })
      .catch((caught: ApiError) => live && setError(caught));
    return () => {
      live = false;
    };
  }, [search, version]);

  async function loadMore() {
    if (!list?.next) return;
    setLoadingMore(true);
    try {
      const page = await api<Page>(reportsPath({ q: search, before: list.next }));
      setList((current) => ({ reports: [...(current?.reports ?? []), ...page.reports], next: page.next }));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, 'ERROR', String(caught)));
    } finally {
      setLoadingMore(false);
    }
  }

  const reports = list?.reports ?? [];
  const groups = groupReports(reports);
  // Shown once there is something to narrow, and kept while a search is typed.
  const showFilter = reports.length > 5 || Boolean(list?.next) || query !== '';

  return (
    <aside className="sidebar" aria-label="Saved reports">
      <div className="sidebar-head">
        <h2 className="sidebar-title">Reports</h2>
        {list && (
          <span className="sidebar-count" title={list.next ? 'More are stored: load them below' : undefined}>
            {reports.length}
            {list.next ? '+' : ''}
          </span>
        )}
      </div>
      {showFilter && (
        <input
          className="input sidebar-filter"
          type="search"
          placeholder="Filter by page"
          aria-label="Filter reports by page"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      {error && <p className="muted">{error.message}</p>}
      {list && reports.length === 0 && <p className="muted">{search ? 'No report matches.' : 'Pages you measure are saved here.'}</p>}

      {groups.map((group) => (
        <section key={group.host} className="host-group">
          <h3 className="host-name" title={group.host}>
            {group.host}
          </h3>
          <ul className="report-list">
            {group.reports.map((report) => (
              <li key={report.reportId}>
                <ReportLink report={report} active={report.reportId === activeId} />
              </li>
            ))}
          </ul>
        </section>
      ))}

      {list?.next && (
        <button type="button" className="button button-quiet sidebar-more" onClick={loadMore} disabled={loadingMore} aria-busy={loadingMore}>
          {loadingMore ? 'Loading' : 'Load more'}
        </button>
      )}
    </aside>
  );
}

function ReportLink({ report, active }: { report: ReportRow; active: boolean }) {
  const score = Math.round(report.score);
  const partial = report.runsSucceeded < report.runsRequested;
  const failing =
    report.targetsTotal > 0 ? `${report.targetsFailing} of ${report.targetsTotal} targets failing` : 'no targets graded';
  return (
    <a
      className={`report-link${active ? ' is-active' : ''}`}
      href={href.report(report.reportId)}
      aria-current={active ? 'page' : undefined}
      title={`${report.url}\n${report.reportId}\n${failing}`}
    >
      <span className="report-main">
        <span className="report-path">{pathOf(report.url)}</span>
        <span className="report-meta">
          {report.strategy === 'mobile' ? 'Mobile' : 'Desktop'}, {formatWhen(measuredAt(report.reportId, report.generatedAt))}
          {partial ? `, ${report.runsSucceeded}/${report.runsRequested} runs` : ''}
        </span>
      </span>
      <span className={`report-score text-${scoreBand(score)}`} aria-label={`Score ${score}`}>
        {score}
      </span>
    </a>
  );
}
