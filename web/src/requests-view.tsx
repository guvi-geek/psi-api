'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { AggregatedReport } from '../../src/types';
import { href } from './router';
import {
  pageOf,
  requestRows,
  requestsFromParams,
  requestsToParams,
  requestTotals,
  TYPE_PLURALS,
  type RequestFilters,
} from './requests';

/** The CLI's --requests: every request the median run made. */
export function RequestsView({ report, params }: { report: AggregatedReport; params: URLSearchParams }) {
  // Paging replaces a row limit, so an old link's limit is ignored.
  const [filters, setFilters] = useState<RequestFilters>(() => ({ ...requestsFromParams(params), limit: undefined }));
  const [page, setPage] = useState(() => Number(params.get('page') ?? 1));
  const ids = useId();
  // Where the pager sat on screen when Previous or Next was pressed, to keep it there.
  const pagerRef = useRef<HTMLElement>(null);
  const pagerTop = useRef<number | null>(null);

  // After the page changes, scroll by however much the pager moved (the last page is
  // often shorter), so the buttons stay under the pointer instead of the page jumping.
  useLayoutEffect(() => {
    const before = pagerTop.current;
    pagerTop.current = null;
    if (before === null || !pagerRef.current) return;
    const moved = pagerRef.current.getBoundingClientRect().top - before;
    if (moved !== 0) window.scrollBy(0, moved);
  }, [page]);

  useEffect(() => {
    const next = requestsToParams(filters);
    next.set('tab', 'requests');
    if (page > 1) next.set('page', String(page));
    history.replaceState(null, '', href.report(report.reportId, next));
  }, [filters, page, report.reportId]);

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
  const { rows: allRows, matched } = requestRows(requests, filters);
  const shown = pageOf(matched, page);
  const rows = allRows.slice(shown.start, shown.end);
  const goTo = (next: number) => {
    pagerTop.current = pagerRef.current?.getBoundingClientRect().top ?? null;
    setPage(next);
  };
  // A new filter or order starts again at the first page.
  const update = (patch: Partial<RequestFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(1);
  };
  const toggleType = (type: string) => {
    setPage(1);
    setFilters((current) => ({
      ...current,
      types: (current.types ?? []).includes(type) ? (current.types ?? []).filter((entry) => entry !== type) : [...(current.types ?? []), type],
    }));
  };

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
        {matched > 0 && (
          <nav className="pager" aria-label="Request pages" ref={pagerRef}>
            <span className="pager-status" aria-live="polite">
              Showing {shown.start + 1}–{shown.end} of {matched} request{matched === 1 ? '' : 's'}
            </span>
            {shown.pages > 1 && (
              <span className="pager-controls">
                <button type="button" className="button button-quiet" onClick={() => goTo(shown.page - 1)} disabled={shown.page === 1}>
                  Previous
                </button>
                <span className="pager-page">
                  Page {shown.page} of {shown.pages}
                </span>
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={() => goTo(shown.page + 1)}
                  disabled={shown.page === shown.pages}
                >
                  Next
                </button>
              </span>
            )}
          </nav>
        )}
      </div>

      <p className="note">
        {matched === 0 ? 'No request matches these filters. ' : ''}
        Start and End are milliseconds after the first request, observed on PSI&apos;s own connection. Use them for order,
        not to compare with FCP or LCP, which are simulated on a throttled link. Hover a size for the uncompressed size.
      </p>
    </div>
  );
}
