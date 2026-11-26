'use client';

import { useEffect, useId, useState } from 'react';
import type { AggregatedReport } from '../../src/types';
import { href } from './router';
import {
  requestRows,
  requestsFromParams,
  requestsToParams,
  requestTotals,
  TYPE_PLURALS,
  type RequestFilters,
} from './requests';

/** The CLI's --requests: every request the median run made. */
export function RequestsView({ report, params }: { report: AggregatedReport; params: URLSearchParams }) {
  const [filters, setFilters] = useState<RequestFilters>(() => requestsFromParams(params));
  const [limitText, setLimitText] = useState(filters.limit === undefined ? '' : String(filters.limit));
  const ids = useId();

  useEffect(() => {
    const next = requestsToParams(filters);
    next.set('tab', 'requests');
    history.replaceState(null, '', href.report(report.reportId, next));
  }, [filters, report.reportId]);

  const requests = report.requests ?? [];
  if (requests.length === 0) {
    return (
      <div className="panel">
        <p className="muted">
          No request table in this report. It was saved before requests were kept. Measure the page again to get one.
        </p>
      </div>
    );
  }

  const totals = requestTotals(requests);
  const { rows, matched } = requestRows(requests, filters);
  const update = (patch: Partial<RequestFilters>) => setFilters((current) => ({ ...current, ...patch }));
  const toggleType = (type: string) =>
    setFilters((current) => ({
      ...current,
      types: (current.types ?? []).includes(type) ? (current.types ?? []).filter((entry) => entry !== type) : [...(current.types ?? []), type],
    }));

  return (
    <div className="stack">
      <div className="panel">
        <p className="request-totals">
          <strong>
            {totals.count} request{totals.count === 1 ? '' : 's'} - {totals.bytes}
          </strong>{' '}
          transferred. {totals.first.count} first-party - {totals.first.bytes}, {totals.third.count} third-party -{' '}
          {totals.third.bytes}
          {totals.notFound > 0 && <span className="text-bad">, {totals.notFound} returned 404 Not Found</span>}.
        </p>
        <ul className="type-list">
          {totals.byType.map((entry) => (
            <li key={entry.type}>
              {entry.label} <span className="muted-cell">- {entry.bytes}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="filter-bar panel">
        <div className="filter-row">
          <div className="segmented" role="radiogroup" aria-label="Whose requests">
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
          <div className="segmented" role="radiogroup" aria-label="Order">
            {(
              [
                ['start', 'In start order'],
                ['size', 'Largest first'],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className={`segment${filters.sortBy === value ? ' is-on' : ''}`}>
                <input type="radio" name={`${ids}-order`} checked={filters.sortBy === value} onChange={() => update({ sortBy: value })} />
                {label}
              </label>
            ))}
          </div>
          <label className="sort-field">
            <span className="filter-label">Show at most</span>
            <input
              className="input small-number"
              type="number"
              min={0}
              step={1}
              value={limitText}
              aria-label="Show at most this many requests"
              aria-invalid={limitText.trim() !== '' && !(Number.isInteger(Number(limitText)) && Number(limitText) >= 0)}
              onChange={(event) => {
                setLimitText(event.target.value);
                const raw = event.target.value.trim();
                const value = Number(raw);
                if (raw === '') update({ limit: undefined });
                else if (Number.isInteger(value) && value >= 0) update({ limit: value });
              }}
            />
          </label>
        </div>

        {/* Types in the report, biggest first; pick any to show only those. */}
        <div className="filter-row">
          <div className="chip-group" role="group" aria-label="Request type">
            <span className="filter-label">Type</span>
            <button type="button" className="chip" aria-pressed={!filters.types?.length} onClick={() => update({ types: undefined })}>
              All
            </button>
            {totals.byType.map((entry) => (
              <button
                key={entry.type}
                type="button"
                className="chip"
                aria-pressed={Boolean(filters.types?.includes(entry.type))}
                onClick={() => toggleType(entry.type)}
              >
                {TYPE_PLURALS[entry.type] ?? `${entry.type}s`} <span className="chip-count">{entry.count}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="panel table-panel">
        <div className="table-scroll">
          <table className="table requests-table">
            <thead>
              <tr>
                <th scope="col" className="num">Start</th>
                <th scope="col" className="num">End</th>
                <th scope="col">Type</th>
                <th scope="col">Priority</th>
                <th scope="col" className="num">Size</th>
                <th scope="col">Party</th>
                <th scope="col">URL</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${row.url}-${index}`} className={row.notFound ? 'is-missing' : undefined}>
                  <td className="num muted-cell">{row.start}</td>
                  <td className="num muted-cell">{row.end}</td>
                  <td>{row.type}</td>
                  <td className="muted-cell">{row.priority}</td>
                  <td className="num" title={`Uncompressed ${row.resourceSize}`}>
                    {row.size}
                  </td>
                  <td className={row.party === 'third' ? 'text-warn' : undefined}>
                    {row.party === 'first' ? 'First' : 'Third'}
                    {row.entity && <span className="muted-cell"> {row.entity}</span>}
                  </td>
                  <td className="request-url">
                    {row.preload && <span className="tag">preload</span>}
                    <span className="mono">{row.url.replace(/^https?:\/\//, '')}</span>
                    {row.status !== '200' && row.status !== '—' && (
                      <span className={row.notFound ? 'text-bad' : 'text-warn'}> {row.notFound ? '404 Not Found' : row.status}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="note">
        {matched === 0 ? 'No request matches these filters. ' : ''}
        {matched > rows.length ? `${matched - rows.length} more hidden by Show at most. ` : ''}
        Start and End are milliseconds after the first request, observed on PSI&apos;s own connection. Use them for order,
        not to compare with FCP or LCP, which are simulated on a throttled link. Hover a size for the uncompressed size.
      </p>
    </div>
  );
}
