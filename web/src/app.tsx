import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, type Health, type Targets } from './api';
import { href, useRoute, type Route } from './router';

function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [state, setState] = useState<{ data?: T; error?: ApiError; loading: boolean }>({ loading: true });
  useEffect(() => {
    if (!path) return;
    let live = true;
    setState({ loading: true });
    api<T>(path)
      .then((data) => live && setState({ data, loading: false }))
      .catch((error: ApiError) => live && setState({ error, loading: false }));
    return () => {
      live = false;
    };
  }, [path, ...deps]);
  return state;
}

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

interface ReportRow {
  reportId: string;
  url: string;
  strategy: string;
  score: number;
}

function Sidebar({ activeId }: { activeId?: string }) {
  const { data, error } = useApi<{ reports: ReportRow[] }>('/reports');
  return (
    <aside className="sidebar" aria-label="Stored reports">
      <h2 className="sidebar-title">Reports</h2>
      {error && <p className="muted">{error.message}</p>}
      {data && data.reports.length === 0 && <p className="muted">Pages you measure are saved here.</p>}
      <ul className="report-list">
        {data?.reports.map((report) => (
          <li key={report.reportId}>
            <a
              className={`report-link${report.reportId === activeId ? ' is-active' : ''}`}
              href={href.report(report.reportId)}
            >
              <span className="report-url">{report.url.replace(/^https?:\/\//, '')}</span>
              <span className="report-meta">
                {report.strategy}, score {report.score}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </aside>
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

function Home() {
  const { data } = useApi<Targets>('/targets');
  return (
    <section className="page">
      <h1 className="page-title">Measure a public page</h1>
      <p className="lede">
        Each report runs the page through PageSpeed Insights several times and keeps the median, the spread,
        and the targets it misses. Open a saved report from the list to re-read it at no quota cost.
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
                  <td className="num">{format(data.mobile[row.key], row.unit)}</td>
                  <td className="num">{format(data.desktop[row.key], row.unit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="note">Set in config/targets.json. A score must reach the target; every other metric must stay under it.</p>
        </div>
      )}
    </section>
  );
}

const format = (value: number, unit: string) => `${value}${unit}`;

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
  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href={href.home()}>
          PSI - API
        </a>
        <div className="topbar-end">
          <HealthBadge />
        </div>
      </header>
      <Sidebar activeId={route?.name === 'report' ? route.reportId : undefined} />
      <main className="workspace" id="main">
        {route?.name === 'home' && <Home />}
        {route?.name === 'report' && <Placeholder title={route.reportId}>The report view is built in a later step.</Placeholder>}
        {route?.name === 'compare' && <Placeholder title="Compare reports">The compare view is built in a later step.</Placeholder>}
        {route?.name === 'missing' && (
          <Placeholder title="Page not found">
            Nothing lives at {route.path}. <a href={href.home()}>Go to the start page</a>.
          </Placeholder>
        )}
      </main>
    </div>
  );
}
