'use client';

import { useState } from 'react';
import { href } from './router';
import { formatWhen, groupReports, pathOf, scoreBand, type ReportRow } from './run';
import { useApi } from './use-api';

/** The CLI's --list: stored reports by host, newest first. Reading them costs no quota. */
export function Sidebar({ activeId, version }: { activeId?: string; version: number }) {
  const { data, error } = useApi<{ reports: ReportRow[] }>('/reports', version);
  const [query, setQuery] = useState('');
  const reports = data?.reports ?? [];
  const groups = groupReports(reports, query);

  return (
    <aside className="sidebar" aria-label="Saved reports">
      <div className="sidebar-head">
        <h2 className="sidebar-title">Reports</h2>
        {data && <span className="sidebar-count">{reports.length}</span>}
        {reports.length > 1 && (
          <a className="sidebar-compare" href={href.compare()}>
            Compare
          </a>
        )}
      </div>
      {reports.length > 5 && (
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
      {data && reports.length === 0 && <p className="muted">Pages you measure are saved here.</p>}
      {data && reports.length > 0 && groups.length === 0 && <p className="muted">No report matches.</p>}

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
          {report.strategy === 'mobile' ? 'Mobile' : 'Desktop'}, {formatWhen(report.generatedAt)}
          {partial ? `, ${report.runsSucceeded}/${report.runsRequested} runs` : ''}
        </span>
      </span>
      <span className={`report-score text-${scoreBand(score)}`} aria-label={`Score ${score}`}>
        {score}
      </span>
    </a>
  );
}
