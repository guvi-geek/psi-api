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
  GROUPS,
  insightFacts,
  insightRowsText,
  insightStats,
  METRICS,
  parseDescription,
  type Filters,
  type Group,
  type Metric,
} from './findings';
import { CopyButton } from './copy-button';
import { METRIC_SHORT } from './overview';
import { href } from './router';

const GROUP_LABELS: Record<Group, string> = {
  opportunity: 'Opportunities',
  diagnostic: 'Diagnostics',
  passed: 'Passed',
  informative: 'Informative',
};

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
  const [moreOpen, setMoreOpen] = useState(() => hasMoreFilters(filtersFromParams(params)));
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
  // Bumped by Clear so the extra number fields start empty again.
  const [clearCount, setClearCount] = useState(0);
  const clearFilters = (keepSort: boolean) => {
    setFilters(keepSort ? { ...DEFAULT_FILTERS, sortBy: filters.sortBy, order: filters.order } : { ...DEFAULT_FILTERS });
    setClearCount((count) => count + 1);
  };
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
        moreOpen={moreOpen}
        setMoreOpen={setMoreOpen}
        active={active}
        clear={() => clearFilters(true)}
        clearCount={clearCount}
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

function hasMoreFilters(filters: Filters): boolean {
  return (
    filters.minSavingsMs !== undefined ||
    filters.minSavingsBytes !== undefined ||
    filters.maxScore !== undefined ||
    filters.minFirstPartyRatio !== undefined ||
    filters.hasItems !== undefined ||
    filters.limit !== undefined ||
    filters.id.length > 0
  );
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

function FilterBar(props: {
  filters: Filters;
  update: (patch: Partial<Filters>) => void;
  moreOpen: boolean;
  setMoreOpen: (open: boolean) => void;
  active: number;
  clear: () => void;
  clearCount: number;
  cli: string;
}) {
  const { filters, update, moreOpen, setMoreOpen, active, clear, clearCount, cli } = props;
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
        <div className="chip-group" role="group" aria-label="Group">
          {GROUPS.map((group) => (
            <button
              key={group}
              type="button"
              className="chip"
              aria-pressed={filters.group.includes(group)}
              onClick={() => update({ group: toggle(filters.group, group) })}
            >
              {GROUP_LABELS[group]}
            </button>
          ))}
        </div>
      </div>

      <div className="filter-row">
        <div className="chip-group" role="group" aria-label="Affects metric">
          <span className="filter-label">Affects</span>
          {METRICS.map((metric) => (
            <button
              key={metric}
              type="button"
              className="chip"
              aria-pressed={filters.metric.includes(metric)}
              onClick={() => update({ metric: toggle(filters.metric, metric as Metric) })}
            >
              {METRIC_SHORT[metric] ?? metric}
            </button>
          ))}
        </div>
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
        <button
          type="button"
          className="button button-quiet"
          aria-expanded={moreOpen}
          aria-controls={`${ids}-more`}
          onClick={() => setMoreOpen(!moreOpen)}
        >
          More filters
        </button>
        {active > 0 && (
          <button type="button" className="button button-quiet" onClick={clear}>
            Clear {active}
          </button>
        )}
        <CopyButton text={cli} label="Copy as CLI" />
      </div>

      {moreOpen && (
        <div className="more-filters" id={`${ids}-more`} key={clearCount}>
          <NumberField label="Saving at least (ms)" value={filters.minSavingsMs} onChange={(value) => update({ minSavingsMs: value })} min={0} />
          <NumberField label="Saving at least (bytes)" value={filters.minSavingsBytes} onChange={(value) => update({ minSavingsBytes: value })} min={0} />
          <NumberField label="Score at most (0–1)" value={filters.maxScore} onChange={(value) => update({ maxScore: value })} min={0} max={1} step={0.05} />
          <NumberField label="Ours at least (0–1)" value={filters.minFirstPartyRatio} onChange={(value) => update({ minFirstPartyRatio: value })} min={0} max={1} step={0.05} />
          <label className="field">
            <span className="field-label">Rows</span>
            <select
              className="input"
              value={filters.hasItems === undefined ? 'any' : filters.hasItems ? 'with' : 'without'}
              onChange={(event) =>
                update({ hasItems: event.target.value === 'any' ? undefined : event.target.value === 'with' })
              }
            >
              <option value="any">With or without rows</option>
              <option value="with">Only with rows</option>
              <option value="without">Only without rows</option>
            </select>
          </label>
          <NumberField label="Show at most" value={filters.limit} onChange={(value) => update({ limit: value })} min={0} step={1} />
          <label className="field field-wide">
            <span className="field-label">Exact ids, comma separated</span>
            <input
              className="input mono"
              value={filters.id.join(',')}
              placeholder="unused-javascript,render-blocking-insight"
              onChange={(event) =>
                update({
                  id: event.target.value
                    .split(',')
                    .map((part) => part.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
        </div>
      )}
    </div>
  );
}

/** A number input that keeps what the person typed and reports only valid numbers. */
function NumberField(props: {
  label: string;
  value?: number;
  onChange: (value: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const { label, value, onChange, min, max, step } = props;
  // Local text, so a half-typed "0." is kept; Clear remounts the field to empty it.
  const [text, setText] = useState(value === undefined ? '' : String(value));
  const invalid = text.trim() !== '' && !isValid(Number(text), min, max);
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        className="input"
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step ?? 'any'}
        value={text}
        aria-label={label}
        aria-invalid={invalid}
        onChange={(event) => {
          setText(event.target.value);
          const raw = event.target.value.trim();
          const parsed = Number(raw);
          if (raw === '') onChange(undefined);
          else if (isValid(parsed, min, max)) onChange(parsed);
        }}
      />
    </label>
  );
}

function isValid(value: number, min?: number, max?: number): boolean {
  return Number.isFinite(value) && (min === undefined || value >= min) && (max === undefined || value <= max);
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
