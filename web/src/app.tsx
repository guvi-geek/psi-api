'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { type Health, type Targets } from './api';
import { href, useRoute, type Route } from './router';
import { CompareView } from './compare-view';
import { ReanalyzeBox } from './reanalyze-box';
import { ReportView } from './report-view';
import { RunForm } from './run-form';
import { RunView } from './run-view';
import { Sidebar } from './sidebar';
import { useApi } from './use-api';

function HealthBadge() {
  const { data, error } = useApi<Health>('/health');
  if (error) return <span className="badge badge-bad" title={error.message}>Server not responding</span>;
  if (!data) return <span className="badge">Connecting</span>;
  return data.apiKeyConfigured ? (
    <span className="badge badge-good">API key set</span>
  ) : (
    <span className="badge badge-warn" title="Without PSI_API_KEY in .env, runs share Google's anonymous quota and usually fail with 429.">
      No API key
    </span>
  );
}

const BUDGET_ROWS: Array<{ key: keyof Targets['mobile']; label: string; unit: string }> = [
  { key: 'score', label: 'Score', unit: '' },
  { key: 'fcp', label: 'First contentful paint', unit: 'ms' },
  { key: 'lcp', label: 'Largest contentful paint', unit: 'ms' },
  { key: 'speedIndex', label: 'Speed index', unit: 'ms' },
  { key: 'tbt', label: 'Total blocking time', unit: 'ms' },
  { key: 'cls', label: 'Cumulative layout shift', unit: '' },
];

function Home({ onChanged }: { onChanged: () => void }) {
  const { data } = useApi<Targets>('/targets');
  return (
    <section className="page">
      <h1 className="page-title">Measure a public page</h1>
      <p className="lede">
        Enter a page above. Each report runs it through PageSpeed Insights several times and keeps the median, the
        spread, and the targets it misses. Saved reports open from the list at no quota cost.
      </p>
      {data && (
        <div className="panel">
          <h2 className="panel-title">Targets every report is graded against</h2>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col" className="num">Mobile</th>
                <th scope="col" className="num">Desktop</th>
              </tr>
            </thead>
            <tbody>
              {BUDGET_ROWS.map((row) => (
                <tr key={row.key}>
                  <td>{row.label}</td>
                  <td className="num">{`${data.mobile[row.key]}${row.unit}`}</td>
                  <td className="num">{`${data.desktop[row.key]}${row.unit}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="note">Set in config/targets.json. A score must reach the target; every other metric must stay under it.</p>
        </div>
      )}
      <div className="panel home-reanalyze">
        <h2 className="panel-title">Rebuild saved reports</h2>
        <ReanalyzeBox onSaved={onChanged} />
      </div>
    </section>
  );
}

function Placeholder({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="page">
      <h1 className="page-title">{title}</h1>
      <p className="lede">{children}</p>
    </section>
  );
}

export function App() {
  // Before mount (and in the pre-rendered HTML) only the frame shows.
  return <Shell route={useRoute() ?? undefined} />;
}

function Shell({ route }: { route?: Route }) {
  // Bumped when a run ends, so the list picks up the new report.
  const [reportsVersion, setReportsVersion] = useState(0);
  const refreshReports = useCallback(() => setReportsVersion((version) => version + 1), []);

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href={href.home()}>
          PSI - API
        </a>
        <RunForm />
        <div className="topbar-end">
          <HealthBadge />
        </div>
      </header>
      <Sidebar activeId={route?.name === 'report' ? route.reportId : undefined} version={reportsVersion} />
      <main className="workspace" id="main">
        {route?.name === 'home' && <Home onChanged={refreshReports} />}
        {route?.name === 'run' && <RunView jobId={route.jobId} onFinished={refreshReports} />}
        {route?.name === 'report' && (
          <ReportView key={route.reportId} reportId={route.reportId} params={route.params} />
        )}
        {route?.name === 'compare' && (
          <CompareView before={route.before} after={route.after} metric={route.metric} version={reportsVersion} />
        )}
        {route?.name === 'missing' && (
          <Placeholder title="Page not found">
            Nothing lives at {route.path}. <a href={href.home()}>Go to the start page</a>.
          </Placeholder>
        )}
      </main>
    </div>
  );
}
