import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { api, ApiError, type Health, type Targets } from './api';
import { href, useRoute } from './router';

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
  if (error) return <span class="badge badge-bad" title={error.message}>Server not responding</span>;
  if (!data) return <span class="badge">Connecting</span>;
  return data.apiKeyConfigured ? (
    <span class="badge badge-good">API key set</span>
  ) : (
    <span class="badge badge-warn" title="Without PSI_API_KEY in .env, runs share Google's anonymous quota and usually fail with 429.">
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
    <aside class="sidebar" aria-label="Stored reports">
      <h2 class="sidebar-title">Reports</h2>
      {error && <p class="muted">{error.message}</p>}
      {data && data.reports.length === 0 && <p class="muted">Pages you measure are saved here.</p>}
      <ul class="report-list">
        {data?.reports.map((report) => (
          <li key={report.reportId}>
            <a
              class={`report-link${report.reportId === activeId ? ' is-active' : ''}`}
              href={href.report(report.reportId)}
            >
              <span class="report-url">{report.url.replace(/^https?:\/\//, '')}</span>
              <span class="report-meta">
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
    <section class="page">
      <h1 class="page-title">Measure a public page</h1>
      <p class="lede">
        Each report runs the page through PageSpeed Insights several times and keeps the median, the spread,
        and the targets it misses. Open a saved report from the list to re-read it at no quota cost.
      </p>
      {data && (
        <div class="panel">
          <h2 class="panel-title">Targets every report is graded against</h2>
          <table class="table">
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col" class="num">Mobile</th>
                <th scope="col" class="num">Desktop</th>
              </tr>
            </thead>
            <tbody>
              {BUDGET_ROWS.map((row) => (
                <tr key={row.key}>
                  <td>{row.label}</td>
                  <td class="num">{format(data.mobile[row.key], row.unit)}</td>
                  <td class="num">{format(data.desktop[row.key], row.unit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p class="note">Set in config/targets.json. A score must reach the target; every other metric must stay under it.</p>
        </div>
      )}
    </section>
  );
}

const format = (value: number, unit: string) => `${value}${unit}`;

function Placeholder({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <section class="page">
      <h1 class="page-title">{title}</h1>
      <p class="lede">{children}</p>
    </section>
  );
}

export function App() {
  const route = useRoute();
  return (
    <div class="shell">
      <header class="topbar">
        <a class="brand" href={href.home()}>
          PSI - API
        </a>
        <div class="topbar-end">
          <HealthBadge />
        </div>
      </header>
      <Sidebar activeId={route.name === 'report' ? route.reportId : undefined} />
      <main class="workspace" id="main">
        {route.name === 'home' && <Home />}
        {route.name === 'report' && <Placeholder title={route.reportId}>The report view is built in a later step.</Placeholder>}
        {route.name === 'compare' && <Placeholder title="Compare reports">The compare view is built in a later step.</Placeholder>}
        {route.name === 'missing' && (
          <Placeholder title="Page not found">
            Nothing lives at {route.path}. <a href={href.home()}>Go to the start page</a>.
          </Placeholder>
        )}
      </main>
    </div>
  );
}
