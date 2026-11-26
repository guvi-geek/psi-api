'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AggregatedInsight, AggregatedReport } from '../../src/types';
import { api, ApiError } from './api';
import {
  activeFilterCount,
  DEFAULT_FILTERS,
  filtersFromParams,
  filtersToApiQuery,
  filtersToCli,
  filtersToParams,
  findingRow,
  insightFacts,
  insightRowsText,
  insightStats,
  parseDescription,
  type Filters,
} from './findings';
import { CopyButton } from './copy-button';
import { href } from './router';

const SORT_LABELS = {
  savingsMs: 'Saving in time',
  savingsBytes: 'Saving in bytes',
  score: 'Lighthouse score',
  firstPartyShare: 'Share that is ours',
} as const;

interface InsightsResponse {
  totalInsights: number;
  matched: number;
  insights: AggregatedInsight[];
}

/** The CLI's FINDINGS table with every filter flag, plus --items for one finding. */
export function FindingsView({ report, params }: { report: AggregatedReport; params: URLSearchParams }) {
  const [filters, setFilters] = useState<Filters>(() => filtersFromParams(params));
  const [selected, setSelected] = useState<string | null>(() => params.get('insight'));
  const [result, setResult] = useState<{ data?: InsightsResponse; error?: ApiError }>({});
  const query = filtersToApiQuery(filters);

  // Keep the page URL in step, in place: typing a search adds no history entries.
  useEffect(() => {
    const next = filtersToParams(filters);
    next.set('tab', 'findings');
    if (selected) next.set('insight', selected);
    history.replaceState(null, '', href.report(report.reportId, next));
  }, [filters, selected, report.reportId]);

  // Ask the server, which filters with the CLI's own code. Debounced for typing.
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      api<InsightsResponse>(`/report/${encodeURIComponent(report.reportId)}/insights?${query}`)
        .then((data) => live && setResult({ data }))
        .catch((error: ApiError) => live && setResult((previous) => ({ data: previous.data, error })));
    }, 180);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, report.reportId]);

  const update = (patch: Partial<Filters>) => setFilters((current) => ({ ...current, ...patch }));
  const clearFilters = (keepSort: boolean) =>
    setFilters(keepSort ? { ...DEFAULT_FILTERS, sortBy: filters.sortBy, order: filters.order } : { ...DEFAULT_FILTERS });
  // Stable, so the open drawer does not re-take focus each time results refresh.
  const closeDrawer = useCallback(() => setSelected(null), []);
  const active = activeFilterCount(filters);
  const data = result.data;
  const insight = selected ? report.insights.find((entry) => entry.id === selected) : undefined;

  return (
    <div className="findings">
      <FilterBar
        filters={filters}
        update={update}
        active={active}
        clear={() => clearFilters(true)}
        cli={filtersToCli(report.reportId, filters)}
      />

      <p className="findings-count" aria-live="polite">
        {data ? (
          data.matched === data.totalInsights ? (
            `${data.totalInsights} findings`
          ) : (
            `${data.matched} of ${data.totalInsights} findings`
          )
        ) : (
          'Loading findings'
        )}
        {result.error && <span className="text-bad"> {result.error.message}</span>}
      </p>

      {data && data.insights.length === 0 ? (
        <div className="panel empty">
          <p>No finding matches these filters.</p>
          {active > 0 && (
            <button type="button" className="button" onClick={() => clearFilters(false)}>
              Clear filters
            </button>
          )}
        </div>
      ) : (
        data && <FindingsTable insights={data.insights} selected={selected} onSelect={setSelected} />
      )}

      <p className="note">
        — in Est. saving means Lighthouse gave no estimate, which is not zero. Ours is how much of the cost is on your
        own hosts. Seen is how many runs the finding appeared in; flaky means under 30%.
      </p>

      {insight && <InsightDrawer insight={insight} report={report} onClose={closeDrawer} />}
    </div>
  );
}

function FilterBar(props: {
  filters: Filters;
  update: (patch: Partial<Filters>) => void;
  active: number;
  clear: () => void;
  cli: string;
}) {
  const { filters, update, active, clear, cli } = props;
  const ids = useId();

  return (
    <div className="filter-bar panel">
      <div className="filter-row">
        <input
          className="input filter-search"
          type="search"
          placeholder="Search id or title"
          aria-label="Search findings by id or title"
          value={filters.search}
          onChange={(event) => update({ search: event.target.value })}
        />
      </div>

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
              <input
                type="radio"
                name={`${ids}-party`}
                checked={filters.party === value}
                onChange={() => update({ party: value })}
              />
              {label}
            </label>
          ))}
        </div>

        <label className="check check-inline">
          <input
            type="checkbox"
            checked={filters.noFlaky}
            aria-label="Hide flaky findings, seen in under 30% of runs"
            onChange={(event) => update({ noFlaky: event.target.checked })}
          />
          <span>Hide flaky</span>
        </label>

        <label className="sort-field">
          <span className="filter-label">Sort by</span>
          <select
            className="input"
            value={filters.sortBy}
            onChange={(event) => update({ sortBy: event.target.value as Filters['sortBy'] })}
          >
            {Object.entries(SORT_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button button-quiet"
          onClick={() => update({ order: filters.order === 'desc' ? 'asc' : 'desc' })}
          aria-label={filters.order === 'desc' ? 'Largest first. Switch to smallest first' : 'Smallest first. Switch to largest first'}
        >
          {filters.order === 'desc' ? 'Largest first' : 'Smallest first'}
        </button>

        <span className="filter-spacer" />
        {active > 0 && (
          <button type="button" className="button button-quiet" onClick={clear}>
            Clear {active}
          </button>
        )}
        <CopyButton text={cli} label="Copy as CLI" />
      </div>
    </div>
  );
}

function FindingsTable(props: { insights: AggregatedInsight[]; selected: string | null; onSelect: (id: string) => void }) {
  const rows = useMemo(() => props.insights.map(findingRow), [props.insights]);
  return (
    <div className="panel table-panel">
      <div className="table-scroll">
        <table className="table findings-table">
          <thead>
            <tr>
              <th scope="col" className="num">Est. saving</th>
              <th scope="col">Finding</th>
              <th scope="col">Affects</th>
              <th scope="col" className="num">Ours</th>
              <th scope="col" className="num">Seen</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={props.selected === row.id ? 'is-selected' : undefined}>
                <td className={`num saving${row.hasSaving ? '' : ' muted-cell'}`}>{row.saving}</td>
                <td>
                  <button type="button" className="finding-link" onClick={() => props.onSelect(row.id)}>
                    <span className="finding-title">{row.title}</span>
                    <span className="finding-id mono">
                      {row.id}
                      {row.flaky && <span className="text-warn"> flaky</span>}
                    </span>
                  </button>
                </td>
                <td className="muted-cell">{row.affects}</td>
                <td className={`num ours-${row.oursTone}`}>{row.ours}</td>
                <td className={`num ${row.flaky ? 'text-warn' : 'muted-cell'}`}>{row.seen}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function InsightDrawer(props: { insight: AggregatedInsight; report: AggregatedReport; onClose: () => void }) {
  const { insight, report, onClose } = props;
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [insight.id, onClose]);

  const facts = insightFacts(insight);
  const stats = insightStats(insight);
  const rows = insightRowsText(insight, report.environment?.screen);

  return (
    <div className="drawer-layer">
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="drawer-head">
          <div>
            <h2 className="drawer-title" id={titleId}>
              {insight.title}
            </h2>
            <p className="drawer-id mono">{insight.id}</p>
          </div>
          <button type="button" className="button button-quiet" ref={closeRef} onClick={onClose}>
            Close
          </button>
        </header>

        <div className="drawer-body">
          {insight.description && (
            <p className="drawer-description">
              {parseDescription(insight.description).map((part, index) =>
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
            </p>
          )}

          <dl className="facts">
            {facts.map((fact) => (
              <div key={fact.label}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>

          {stats.length > 0 && (
            <table className="table drawer-stats">
              <thead>
                <tr>
                  <th scope="col">Across runs</th>
                  <th scope="col" className="num">Mean</th>
                  <th scope="col" className="num">Median</th>
                  <th scope="col" className="num">Most common</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((row) => (
                  <tr key={row.name}>
                    <td>{row.name}</td>
                    <td className="num">{row.mean}</td>
                    <td className="num">{row.median}</td>
                    <td className="num">{row.mode}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {insight.stackPacks && insight.stackPacks.length > 0 && (
            <section className="drawer-section">
              <h3 className="drawer-subtitle">Framework notes</h3>
              {insight.stackPacks.map((pack) => (
                <p key={pack.id} className="muted">
                  <strong>{pack.title}:</strong> {pack.description}
                </p>
              ))}
            </section>
          )}

          <section className="drawer-section">
            <h3 className="drawer-subtitle">Rows, as the CLI prints them with --items</h3>
            <pre className="rows-text">{rows}</pre>
          </section>
        </div>
      </aside>
    </div>
  );
}
