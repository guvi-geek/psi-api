'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import {
  changeText,
  compareCli,
  compareQuery,
  compareSides,
  COMPARE_METRICS,
  isCompareMetric,
  metricLabel,
  mismatch,
  reportOption,
  requestChanges,
  VERDICT_TONE,
  type CompareResponse,
} from './compare';
import { CopyButton } from './copy-button';
import { href } from './router';
import type { ReportRow } from './run';
import { useApi } from './use-api';

/** The CLI's --compare: KEEP, REVERT or INCONCLUSIVE for one metric, judged on its own spread. */
export function CompareView(props: { before?: string; after?: string; metric?: string; version: number }) {
  const { data: list, error: listError } = useApi<{ reports: ReportRow[] }>('/reports', props.version);
  const reports = list?.reports ?? [];
  const metric = isCompareMetric(props.metric) ? props.metric : undefined;
  const [state, setState] = useState<{ result?: CompareResponse; error?: ApiError; loading?: boolean }>({});

  const go = (before?: string, after?: string, nextMetric?: string) => {
    location.hash = href.compare(before, after, nextMetric);
  };

  useEffect(() => {
    if (!props.before || !props.after) {
      setState({});
      return;
    }
    let live = true;
    setState((previous) => ({ result: previous.result, loading: true }));
    api<CompareResponse>(`/compare?${compareQuery(props.before, props.after, metric)}`)
      .then((result) => live && setState({ result }))
      .catch((error: ApiError) => live && setState({ error }));
    return () => {
      live = false;
    };
  }, [props.before, props.after, metric]);

  const before = reports.find((report) => report.reportId === props.before);
  const after = reports.find((report) => report.reportId === props.after);
  const warning = mismatch(before, after);
  const result = state.result;

  return (
    <section className="page page-wide">
      <h1 className="page-title">Compare two reports</h1>
      <p className="lede">
        Did a change help? The verdict is judged on one metric&apos;s 75th percentile against its own spread, so noise
        between runs is not read as a win. Comparing saved reports costs no quota.
      </p>

      <div className="filter-bar panel compare-pickers">
        <ReportPicker label="Before" value={props.before} reports={reports} onChange={(id) => go(id, props.after, metric)} />
        <button
          type="button"
          className="button button-quiet swap"
          onClick={() => go(props.after, props.before, metric)}
          disabled={!props.before && !props.after}
          aria-label="Swap before and after"
          title="Swap before and after"
        >
          ⇄
        </button>
        <ReportPicker label="After" value={props.after} reports={reports} onChange={(id) => go(props.before, id, metric)} />
        <label className="field compare-metric">
          <span className="field-label">Metric</span>
          <select
            className="input"
            value={metric ?? ''}
            onChange={(event) => go(props.before, props.after, event.target.value || undefined)}
          >
            <option value="">First failing metric (CLI default)</option>
            {COMPARE_METRICS.map((key) => (
              <option key={key} value={key}>
                {metricLabel(key)}
              </option>
            ))}
          </select>
        </label>
        {/* About the choice of reports, so it lives with the pickers, not above the result. */}
        {warning && (
          <p className="compare-note" role="note">
            {warning}
            {warning.startsWith('These reports') && ' The verdict still compares the numbers, but they are not like for like.'}
          </p>
        )}
      </div>

      <div className="compare-body">
        {listError && <p className="form-error">{listError.message}</p>}
        {!props.before || !props.after ? (
          <p className="muted">Choose a before and an after report.</p>
        ) : state.error ? (
          <p className="form-error">{state.error.message}</p>
        ) : !result ? (
          <p className="muted">Comparing.</p>
        ) : (
          <CompareResult result={result} loading={Boolean(state.loading)} />
        )}
      </div>
    </section>
  );
}

function ReportPicker(props: { label: string; value?: string; reports: ReportRow[]; onChange: (id: string) => void }) {
  const known = props.reports.some((report) => report.reportId === props.value);
  return (
    <label className="field compare-picker">
      <span className="field-label">{props.label}</span>
      <select className="input" value={props.value ?? ''} onChange={(event) => props.onChange(event.target.value)}>
        <option value="" disabled>
          Choose a saved report
        </option>
        {props.value && !known && <option value={props.value}>{props.value} (not found)</option>}
        {props.reports.map((report) => (
          <option key={report.reportId} value={report.reportId}>
            {reportOption(report)}
          </option>
        ))}
      </select>
    </label>
  );
}

function CompareResult({ result, loading }: { result: CompareResponse; loading: boolean }) {
  const sides = compareSides(result);
  const requests = requestChanges(result);
  const tone = VERDICT_TONE[result.verdict];
  return (
    <div className="stack" aria-busy={loading}>
      <div className={`panel verdict-panel verdict-${tone}`}>
        <div className="verdict-panel-head">
          <span className={`compare-verdict text-${tone}`}>{result.verdict}</span>
          <span className="compare-metric-name">{metricLabel(result.metric)}</span>
          <span className="filter-spacer" />
          <CopyButton text={compareCli(result.beforeId, result.afterId, result.metric)} label="Copy as CLI" />
        </div>
        <p className="compare-reason">{result.reason}</p>
        <p className="compare-change">
          {changeText(result.metric, result.p75Delta)}
          {result.bimodal && <span className="text-warn">. The metric splits into two groups in at least one report.</span>}
        </p>
      </div>

      <div className="details-grid">
        {sides.map((side) => (
          <div key={side.label} className="panel">
            <h2 className="panel-title">{side.label}</h2>
            <dl className="facts">
              <div>
                <dt>Report</dt>
                <dd>
                  <a className="mono" href={href.report(side.reportId)}>
                    {side.reportId}
                  </a>
                </dd>
              </div>
              <div>
                <dt>p75</dt>
                <dd className="strong">{side.p75}</dd>
              </div>
              <div>
                <dt>Stddev</dt>
                <dd>{side.stddev}</dd>
              </div>
              <div>
                <dt>Pass rate</dt>
                <dd>{side.passRate}</dd>
              </div>
            </dl>
          </div>
        ))}
      </div>

      <div className="panel">
        <h2 className="panel-title">Requests</h2>
        {!requests ? (
          <p className="muted">One of these reports was saved before requests were kept.</p>
        ) : (
          <dl className="facts">
            <div>
              <dt>HTML document</dt>
              <dd>{requests.document}</dd>
            </div>
            {requests.changes.map((change) => (
              <div key={change.label}>
                <dt>{change.label}</dt>
                <dd className={change.items.length ? 'mono' : 'muted-cell'}>{change.items.join(', ') || 'None'}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      {result.cautions.length > 0 && (
        <div className="panel cautions">
          <h2 className="panel-title">Before you trust this verdict</h2>
          <ul className="alert-list">
            {result.cautions.map((caution) => (
              <li key={caution}>{caution}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
