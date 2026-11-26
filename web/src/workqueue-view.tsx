'use client';

import { useEffect, useId, useState } from 'react';
import type { AggregatedReport, ImageChecks } from '../../src/types';
import type { Diagnosis } from '../../src/diagnose';
import { api, ApiError } from './api';
import { CopyButton } from './copy-button';
import { href } from './router';
import {
  gapRow,
  imageRow,
  lcpView,
  queueFromParams,
  queueRow,
  queueToApiQuery,
  queueToCli,
  queueToParams,
  unreliableText,
  type WorkQueueFilters,
} from './workqueue';
import { METRIC_NAMES } from './overview';

type DiagnosisResponse = Diagnosis & { images: ImageChecks };

/** The CLI's --diagnose: what is failing, what to work on, and what to distrust. */
export function WorkQueueView({ report, params }: { report: AggregatedReport; params: URLSearchParams }) {
  const [filters, setFilters] = useState<WorkQueueFilters>(() => queueFromParams(params));
  const [state, setState] = useState<{ data?: DiagnosisResponse; error?: ApiError }>({});
  const query = queueToApiQuery(filters);
  const ids = useId();

  useEffect(() => {
    const next = queueToParams(filters);
    next.set('tab', 'queue');
    history.replaceState(null, '', href.report(report.reportId, next));
  }, [filters, report.reportId]);

  useEffect(() => {
    let live = true;
    api<DiagnosisResponse>(`/report/${encodeURIComponent(report.reportId)}/diagnosis?${query}`)
      .then((data) => live && setState({ data }))
      .catch((error: ApiError) => live && setState((previous) => ({ data: previous.data, error })));
    return () => {
      live = false;
    };
  }, [query, report.reportId]);

  const update = (patch: Partial<WorkQueueFilters>) => setFilters((current) => ({ ...current, ...patch }));
  const data = state.data;

  return (
    <div className="stack">
      <div className="filter-bar panel">
        <div className="filter-row">
          <div className="segmented" role="radiogroup" aria-label="Whose cost">
            {(
              [
                ['any', 'Anyone'],
                ['first', 'Ours'],
                ['third', 'Third party'],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className={`segment${filters.party === value ? ' is-on' : ''}`}>
                <input type="radio" name={`${ids}-party`} checked={filters.party === value} onChange={() => update({ party: value })} />
                {label}
              </label>
            ))}
          </div>
          <label className="sort-field">
            <span className="filter-label">Rank by</span>
            <select className="input" value={filters.sortBy} onChange={(event) => update({ sortBy: event.target.value as WorkQueueFilters['sortBy'] })}>
              <option value="savingsMs">Saving in time</option>
              <option value="savingsBytes">Saving in bytes</option>
              <option value="score">Lighthouse score</option>
              <option value="firstPartyShare">Share that is ours</option>
            </select>
          </label>
          <SmallNumber label="Ours at least (0–1)" value={filters.minFirstPartyRatio} min={0} max={1} step={0.05} onChange={(value) => update({ minFirstPartyRatio: value })} />
          <SmallNumber label="Show at most" value={filters.limit} min={0} step={1} integer onChange={(value) => update({ limit: value })} />
          <label className="check check-inline">
            <input type="checkbox" checked={filters.noFlaky} aria-label="Hide flaky findings" onChange={(event) => update({ noFlaky: event.target.checked })} />
            <span>Hide flaky</span>
          </label>
          <span className="filter-spacer" />
          <CopyButton text={queueToCli(report.reportId, filters)} label="Copy as CLI" />
        </div>
      </div>

      {state.error && <p className="form-error">{state.error.message}</p>}
      {!data && !state.error && <p className="lede">Ranking the work.</p>}
      {data && <DiagnosisBody report={report} data={data} />}
    </div>
  );
}

function SmallNumber(props: {
  label: string;
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  onChange: (value: number | undefined) => void;
}) {
  const { label, value, min, max, step, integer, onChange } = props;
  const [text, setText] = useState(value === undefined ? '' : String(value));
  const valid = (n: number) =>
    Number.isFinite(n) && (!integer || Number.isInteger(n)) && (min === undefined || n >= min) && (max === undefined || n <= max);
  return (
    <label className="sort-field">
      <span className="filter-label">{label}</span>
      <input
        className="input small-number"
        type="number"
        min={min}
        max={max}
        step={step}
        value={text}
        aria-label={label}
        aria-invalid={text.trim() !== '' && !valid(Number(text))}
        onChange={(event) => {
          setText(event.target.value);
          const raw = event.target.value.trim();
          if (raw === '') onChange(undefined);
          else if (valid(Number(raw))) onChange(Number(raw));
        }}
      />
    </label>
  );
}

function DiagnosisBody({ report, data }: { report: AggregatedReport; data: DiagnosisResponse }) {
  const gaps = data.priorityOrder.map(gapRow);
  const rows = data.ranked.map(queueRow);
  const lcp = lcpView(report.lcp);
  const images = data.images;
  const unreliable = unreliableText(data);
  const seeds = data.evidence?.grep ?? [];

  return (
    <>
      {data.exhausted && (
        <div className="alert alert-stop" role="status">
          <h2 className="alert-title">Stop: no first-party work remains against the failing metrics</h2>
          <p>Report what you found and escalate. Nothing left in this queue is yours to fix.</p>
        </div>
      )}

      <section className="panel">
        <h2 className="panel-title">
          {data.primary
            ? `Work on ${METRIC_NAMES[data.primary.metric] ?? data.primary.metric} first`
            : 'Every measured metric is inside its target'}
        </h2>
        {gaps.length > 0 && (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Failing target, worst first</th>
                  <th scope="col" className="num">{report.stat[0]!.toUpperCase() + report.stat.slice(1)}</th>
                  <th scope="col" className="num">Target</th>
                  <th scope="col">Verdict</th>
                  <th scope="col" className="num">Runs in target</th>
                </tr>
              </thead>
              <tbody>
                {gaps.map((gap) => (
                  <tr key={gap.metric}>
                    <td className={gap.over ? 'text-bad' : undefined}>{gap.name}</td>
                    <td className="num strong">{gap.value}</td>
                    <td className="num muted-cell">{gap.target}</td>
                    <td className={gap.over ? 'text-bad' : 'text-good'}>{gap.verdict}</td>
                    <td className={`num text-${gap.severity}`}>{gap.runsInTarget}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {unreliable.map((line) => (
          <p key={line} className="note-warn">
            {line}. Judged on the tail, so it fails.
          </p>
        ))}
        {data.blocked.length > 0 && (
          <div className="blocked">
            <h3 className="drawer-subtitle">Not reachable from the frontend</h3>
            <ul className="alert-list">
              {data.blocked.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="panel">
        <h2 className="panel-title">Work queue</h2>
        {rows.length === 0 ? (
          <p className="muted">Nothing actionable against the failing metrics with these filters.</p>
        ) : (
          <ol className="queue">
            {rows.map((row) => (
              <li key={row.id} className="queue-item">
                <span className="queue-rank">{row.rank}</span>
                <div className="queue-main">
                  <div className="queue-head">
                    <a
                      className="queue-title"
                      href={href.report(report.reportId, new URLSearchParams({ tab: 'findings', insight: row.id }))}
                    >
                      {row.title}
                    </a>
                    <span className="queue-saving">{row.saving}</span>
                  </div>
                  <p className="queue-meta">
                    <span className="mono">{row.id}</span>
                    {row.flaky && <span className="text-warn"> flaky</span>}
                    <span>, affects {row.affects}</span>
                    <span>
                      , ours <span className={`ours-${row.oursTone}`}>{row.ours}</span>
                    </span>
                  </p>
                  <p className="queue-reason">{row.reason}</p>
                  {row.sop && (
                    <p className="queue-sop">
                      <span className="queue-sop-route">{row.sop.sop}</span> {row.sop.action}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
        {seeds.length > 0 && (
          <p className="grep-seeds">
            <span className="filter-label">Search the code for</span>
            {seeds.map((seed) => (
              <code key={seed} className="seed">
                {seed}
              </code>
            ))}
          </p>
        )}
      </section>

      {data.cautions.length > 0 && (
        <section className="panel cautions">
          <h2 className="panel-title">Before you trust these numbers</h2>
          <ul className="alert-list">
            {data.cautions.map((caution) => (
              <li key={caution}>{caution}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="details-grid">
        {lcp && (
          <section className="panel">
            <h2 className="panel-title">Largest contentful paint element</h2>
            <p className="lcp-element">
              <span className="mono">&lt;{lcp.tag}&gt;</span> {lcp.kind}
              {lcp.label && (
                <span className="muted-cell">
                  {' '}
                  {lcp.label.isAlt ? 'alt ' : ''}&ldquo;{lcp.label.text}&rdquo;
                </span>
              )}
            </p>
            {lcp.selector && <p className="mono lcp-selector">{lcp.selector}</p>}
            {lcp.phases.length > 0 && (
              <>
                <div className="phase-bar" aria-hidden="true">
                  {lcp.phases.map((phase, index) => (
                    <span key={phase.key} className={`phase phase-${index}`} style={{ width: `${phase.share * 100}%` }} />
                  ))}
                </div>
                <ul className="phase-legend">
                  {lcp.phases.map((phase, index) => (
                    <li key={phase.key}>
                      <span className={`phase-dot phase-${index}`} />
                      {phase.name} <strong>{phase.ms}ms</strong>
                    </li>
                  ))}
                </ul>
                <p className="note">
                  {lcp.totalMs}ms in total, in timeline order. The bottleneck is {lcp.bottleneck}.
                </p>
              </>
            )}
          </section>
        )}

        <section className="panel">
          <h2 className="panel-title">Image checks</h2>
          <p className="note image-screen">
            Screen {images.screen.width}×{images.screen.height} at {images.screen.deviceScaleFactor}×
            {images.screen.source === 'default' ? ', assumed' : ''}
          </p>
          {images.findings.length === 0 ? (
            <p className="text-good">Nothing to fix in the images this run could see.</p>
          ) : (
            <ul className="image-list">
              {images.findings.map((finding, index) => {
                const row = imageRow(finding);
                return (
                  <li key={index}>
                    <p className="image-head">
                      <span className={row.fine ? 'text-good' : 'text-warn'}>{row.label}</span>
                      {row.size && <span className="muted-cell"> {row.size}</span>}
                    </p>
                    <p className="mono image-where">{row.where}</p>
                    <p className="muted image-detail">{row.detail}</p>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
