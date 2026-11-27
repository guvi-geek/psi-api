'use client';

import { Fragment, useEffect, useState } from 'react';
import type { AggregatedReport } from '../../src/types';
import type { MeasurementValidity } from '../../src/validity';
import { environmentLine, lighthouseLabel } from '../../src/render';
import { api, ApiError, startRun, type Targets } from './api';
import {
  fieldRows,
  metricRows,
  notFound,
  scoreSummary,
  statsTable,
  verdictSummary,
  type MetricRow,
  type SpreadItem,
} from './overview';
import { rerunRequest } from './reanalyze';
import { FindingsView } from './findings-view';
import { RequestsView } from './requests-view';
import { SeoView } from './seo-view';
import { href } from './router';
import { columnsOf, formatWhen, measuredAt } from './run';
import { useApi } from './use-api';

interface Loaded {
  report: AggregatedReport;
  /** From /diagnosis: judged on the stored runs, which only the server reads. */
  validity?: MeasurementValidity;
}

/** A saved report. Reading it costs no quota. */
export function ReportView(props: { reportId: string; params: URLSearchParams }) {
  const { reportId, params } = props;
  const [state, setState] = useState<{ data?: Loaded; error?: ApiError }>({});

  useEffect(() => {
    let live = true;
    setState({});
    const id = encodeURIComponent(reportId);
    Promise.all([
      api<AggregatedReport>(`/report/${id}`),
      api<{ validity?: MeasurementValidity }>(`/report/${id}/diagnosis`).catch(() => ({ validity: undefined })),
    ])
      .then(([report, diagnosis]) => live && setState({ data: { report, validity: diagnosis.validity } }))
      .catch((error: ApiError) => live && setState({ error }));
    return () => {
      live = false;
    };
  }, [reportId]);

  if (state.error) {
    return (
      <section className="page">
        <h1 className="page-title">{state.error.status === 404 ? 'No saved report with this id' : 'Cannot open this report'}</h1>
        <p className="lede">
          {state.error.status === 404
            ? `${reportId} is not in data/. It may have been measured with saving turned off, or moved.`
            : state.error.message}
        </p>
      </section>
    );
  }
  if (!state.data) {
    return (
      <section className="page" aria-busy="true">
        <p className="lede">Opening the report.</p>
      </section>
    );
  }

  const { report, validity } = state.data;
  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'findings', label: `Findings ${report.insights.length}` },
    { id: 'requests', label: `Requests ${report.requests?.length ?? 0}` },
    { id: 'seo', label: 'SEO and more' },
  ] as const;
  const tab = tabs.find((entry) => entry.id === params.get('tab'))?.id ?? 'overview';
  return (
    <section className="page page-wide">
      <ReportHeader report={report} />
      <nav className="tabs" aria-label="Report views">
        {tabs.map((entry) => (
          <a
            key={entry.id}
            className={`tab${tab === entry.id ? ' is-on' : ''}`}
            aria-current={tab === entry.id ? 'page' : undefined}
            href={href.report(report.reportId, entry.id === 'overview' ? undefined : new URLSearchParams({ tab: entry.id }))}
          >
            {entry.label}
          </a>
        ))}
      </nav>
      {tab === 'overview' && <Overview report={report} validity={validity} />}
      {tab === 'findings' && <FindingsView report={report} params={params} />}
      {tab === 'requests' && <RequestsView report={report} params={params} />}
      {tab === 'seo' && <SeoView report={report} params={params} />}
    </section>
  );
}

function ReportHeader({ report }: { report: AggregatedReport }) {
  const measured = measuredAt(report.reportId, report.generatedAt);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = rerunRequest(report);

  // Measures the page again with this report's own settings, as a new saved report.
  async function reanalyze() {
    setError(null);
    setStarting(true);
    try {
      const { jobId } = await startRun(request);
      location.hash = href.run(jobId);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
      setStarting(false);
    }
  }

  return (
    <header className="report-header-wrap">
      <div className="report-header">
        <div className="report-heading">
          <h1 className="page-title report-title mono">{report.url}</h1>
          <p className="report-sub">
            {report.strategy === 'mobile' ? 'Mobile' : 'Desktop'}, {lighthouseLabel(report.lighthouseVersion)},{' '}
            {report.stat} of {report.runsSucceeded}/{report.runsRequested} runs,{' '}
            <time dateTime={measured} title={new Date(measured).toLocaleString()}>
              {formatWhen(measured)}
            </time>
          </p>
        </div>
        <div className="report-actions">
          <button
            type="button"
            className="button button-quiet"
            onClick={reanalyze}
            disabled={starting}
            title={`Measure this page again: ${request.strategy}, ${request.runs} runs, ${request.stat}. Uses ${request.runs} PSI call${request.runs === 1 ? '' : 's'} from your quota and saves a new report.`}
          >
            {starting ? 'Starting' : 'Re-analyze'}
          </button>
        </div>
      </div>
      {error && (
        <p className="form-error report-error" role="alert">
          {error}
        </p>
      )}
    </header>
  );
}

function Overview({ report, validity }: { report: AggregatedReport; validity?: MeasurementValidity }) {
  const missing = notFound(report);
  const failed = report.errors.filter((error) => error.message);
  return (
    <div className="overview">
      {validity && !validity.usable && (
        <div className="alert alert-bad" role="alert">
          <h2 className="alert-title">Do not use this report</h2>
          <ul className="alert-list">
            {validity.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
      {missing.pageUrl && (
        <div className="alert alert-bad" role="alert">
          <h2 className="alert-title">The page returned 404 Not Found</h2>
          <p>
            <span className="mono">{missing.pageUrl}</span> returned 404, so these numbers describe that error page, not
            the page you asked to measure. Check the URL and the deploy, then measure again.
          </p>
        </div>
      )}
      {missing.files.length > 0 && (
        <div className="alert alert-warn">
          <h2 className="alert-title">
            {missing.files.length} file{missing.files.length === 1 ? '' : 's'} returned 404 Not Found
          </h2>
          <p>{missing.pageUrl ? 'Also missing:' : 'The page loaded, but these did not. A missing script or stylesheet is a broken deploy, not a slow page.'}</p>
          <ul className="alert-list mono">
            {missing.files.slice(0, 8).map((url) => (
              <li key={url}>{url}</li>
            ))}
          </ul>
          {missing.files.length > 8 && <p className="muted">{missing.files.length - 8} more in the request list.</p>}
        </div>
      )}

      <SummaryBlock report={report} />

      <MetricsTable report={report} />

      <div className="details-grid">
        <FieldBlock report={report} />
        <MeasurementBlock report={report} failed={failed} />
      </div>

      <StatsBlock report={report} />
    </div>
  );
}

function Spread({ items }: { items: SpreadItem[] }) {
  return (
    <dl className="spread">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Score and verdict in one panel: the two numbers a reader looks for first. */
function SummaryBlock({ report }: { report: AggregatedReport }) {
  const score = scoreSummary(report);
  // Every failing target: there are only a handful, and the table has room.
  const verdict = verdictSummary(report, Infinity);
  // The score has its own column, so the list names only the metrics.
  const failingMetrics = verdict.named.filter((entry) => entry.metric !== 'score');
  const range = score.spread.find((item) => item.label === 'Range')?.value;
  const meta = [
    score.target !== undefined ? `target ${score.target}` : null,
    range ? `range ${range}` : null,
  ].filter(Boolean);
  return (
    <div className="panel summary">
      <div className="summary-cell summary-score">
        <p className="summary-label">
          Score · {report.stat} of {report.runsSucceeded} runs
        </p>
        <p className="score-line">
          <span className={`score-value text-${score.severity}`}>{score.value}</span>
          <span className="score-of">/ 100</span>
        </p>
        <p className="score-meta">{meta.join(' · ')}</p>
      </div>

      <div className="summary-cell summary-verdict">
        <p className="summary-label">Verdict</p>
        <p
          className={`verdict-word text-${verdict.word === 'PASS' ? 'good' : 'bad'}`}
          title="FAIL means more than half the targets fail. A target fails when fewer than 90% of runs hold it."
        >
          {verdict.word}
        </p>
        <p className="verdict-scope">
          {verdict.failing} of {verdict.total} target{verdict.total === 1 ? '' : 's'} failing
        </p>
      </div>

      <div className="summary-cell summary-failing">
        <p className="summary-label">{failingMetrics.length > 0 ? 'Failing targets' : 'Targets'}</p>
        {failingMetrics.length > 0 ? (
          // Two per column, columns side by side; each divider runs the full height.
          <div className="failing-cols">
            {columnsOf(failingMetrics, 2).map((column) => (
              <ul key={column[0]!.metric} className="failing-col">
                {column.map((entry) => (
                  <li key={entry.metric} title={entry.text}>
                    <span className="failing-name">{entry.short}</span>
                    <span className="failing-sep" aria-hidden="true">-</span>
                    <span className="failing-value text-bad">{entry.actual}</span>
                  </li>
                ))}
              </ul>
            ))}
          </div>
        ) : (
          <p className="verdict-ok">
            {verdict.failing > 0 ? 'Every metric holds; only the score misses its target.' : 'Every target holds on at least 90% of runs.'}
          </p>
        )}
      </div>

      {(score.bimodalNote || verdict.tailOnly || verdict.blockedBy.length > 0) && (
        <div className="summary-notes">
          {score.bimodalNote && <p className="note-warn">The score splits into two groups: {score.bimodalNote}</p>}
          {verdict.tailOnly && (
            <p className="note-warn">Every median is inside its target, but too few individual runs are. Targets are graded on the tail.</p>
          )}
          {verdict.blockedBy.map((reason) => (
            <p key={reason} className="note-warn">
              Not fixable from the frontend: {reason}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function MetricsTable({ report }: { report: AggregatedReport }) {
  const rows = metricRows(report);
  const [open, setOpen] = useState<string | null>(null);
  if (rows.length === 0) return null;
  const statLabel = report.stat[0]!.toUpperCase() + report.stat.slice(1);
  return (
    <div className="panel">
      <h2 className="panel-title">Metrics against their targets</h2>
      <div className="table-scroll">
        <table className="table metrics-table">
          <thead>
            <tr>
              <th scope="col">Metric</th>
              <th scope="col" className="num">{statLabel}</th>
              <th scope="col" className="num">Target</th>
              <th scope="col">Verdict</th>
              <th scope="col" className="num">Of target</th>
              <th scope="col" className="bar-col">
                <span className="visually-hidden">Share of target, 0 to 200%</span>
              </th>
              <th scope="col" className="num">Runs in target</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Fragment key={row.key}>
                <tr className={open === row.key ? 'is-open' : undefined}>
                  <th scope="row">
                    <button
                      type="button"
                      className="row-toggle"
                      aria-expanded={open === row.key}
                      onClick={() => setOpen(open === row.key ? null : row.key)}
                    >
                      <span className={row.over ? 'text-bad' : undefined}>{row.name}</span>
                      <span className="metric-short">{row.short}</span>
                    </button>
                  </th>
                  <td className="num strong">{row.value}</td>
                  <td className="num muted-cell">{row.target}</td>
                  <td className={row.over ? 'text-bad' : 'text-good'}>{row.verdict}</td>
                  <td className={`num ${row.over ? 'text-bad' : 'muted-cell'}`}>{row.percent}</td>
                  <td className="bar-col">
                    <TargetBar row={row} />
                  </td>
                  <td className={`num text-${row.severity}`}>{row.runsInTarget}</td>
                </tr>
                {open === row.key && (
                  <tr className="row-detail">
                    <td colSpan={7}>
                      <MetricDetail row={row} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">
        The verdict judges the {report.stat} only. Runs in target is the tail: green at 90% or more, amber from 70% or
        when the {report.stat} is inside, red below. Select a metric to see its spread and every run.
      </p>
    </div>
  );
}

/** The CLI's ruler: 0 to 200% of the target, with the target at the midpoint. */
function TargetBar({ row }: { row: MetricRow }) {
  if (!row.hasTarget) return null;
  return (
    <span className="target-bar" aria-hidden="true">
      <span className={`target-fill${row.bar.over ? ' is-over' : ''}`} style={{ width: `${row.bar.fillPercent}%` }} />
      <span className="target-mark" />
    </span>
  );
}

function MetricDetail({ row }: { row: MetricRow }) {
  return (
    <div className="metric-detail">
      <Spread items={row.spread} />
      {row.values.length > 0 && (
        <p className="run-values">
          <span className="muted-label">Each run</span> {row.values.join(', ')}
        </p>
      )}
      {row.bimodalNote && <p className="note-warn">Two groups: {row.bimodalNote}</p>}
    </div>
  );
}

function FieldBlock({ report }: { report: AggregatedReport }) {
  // CrUX-only targets (config/targets.json `field`), e.g. INP and TTFB, which the lab cannot grade.
  const { data: targets } = useApi<Targets>('/targets');
  const rows = fieldRows(report, targets?.field);
  return (
    <div className="panel">
      <h2 className="panel-title">Real users (CrUX, 75th percentile)</h2>
      {rows ? (
        <>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col" className="num">p75</th>
                <th scope="col" className="num">Target</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td>{row.name}</td>
                  <td className={`num${row.severity ? ` strong text-${row.severity}` : ' muted-cell'}`}>{row.value}</td>
                  <td className="num muted-cell">{row.target}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <p className="muted">
          No field data for this page. CrUX needs enough real traffic, so this is normal on staging. Judge on the lab
          numbers above.
        </p>
      )}
    </div>
  );
}

function MeasurementBlock({ report, failed }: { report: AggregatedReport; failed: AggregatedReport['errors'] }) {
  const screen = report.environment?.screen;
  return (
    <div className="panel">
      <h2 className="panel-title">How it was measured</h2>
      <dl className="facts">
        <div>
          <dt>Measured under</dt>
          <dd>{environmentLine(report.environment)}</dd>
        </div>
        {screen && (
          <div>
            <dt>Screen</dt>
            <dd>
              {screen.width} × {screen.height}, {screen.deviceScaleFactor}× pixels
              {screen.source === 'default' ? ' (Lighthouse default)' : ''}
            </dd>
          </div>
        )}
        <div>
          <dt>Runs</dt>
          <dd>
            {report.runsSucceeded} of {report.runsRequested} succeeded
          </dd>
        </div>
        <div>
          <dt>Measured</dt>
          <dd>{new Date(measuredAt(report.reportId, report.generatedAt)).toLocaleString()}</dd>
        </div>
        <div>
          <dt>Report built</dt>
          <dd>{new Date(report.generatedAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt>Report id</dt>
          <dd className="mono">{report.reportId}</dd>
        </div>
      </dl>
      {failed.length > 0 && (
        <div className="failed-runs">
          <p className="note-warn">
            {failed.length} run{failed.length === 1 ? '' : 's'} failed
          </p>
          <ul className="alert-list">
            {failed.map((failure) => (
              <li key={failure.run}>
                Run {failure.run}: {failure.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.runWarnings && report.runWarnings.length > 0 && (
        <div className="failed-runs">
          <p className="note-warn">Lighthouse warned</p>
          <ul className="alert-list">
            {report.runWarnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      {report.runtimeError && <p className="note-warn">Runtime error: {report.runtimeError}</p>}
    </div>
  );
}

function StatsBlock({ report }: { report: AggregatedReport }) {
  const rows = statsTable(report);
  return (
    <details className="panel stats-block">
      <summary className="panel-title">Every statistic side by side</summary>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Metric</th>
            <th scope="col" className="num">Mean</th>
            <th scope="col" className="num">Median</th>
            <th scope="col" className="num">Most common</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td>{row.name}</td>
              <td className="num">{row.mean}</td>
              <td className="num">{row.median}</td>
              <td className="num">{row.mode}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note">The headline uses the {report.stat}, chosen when the report was measured.</p>
    </details>
  );
}
