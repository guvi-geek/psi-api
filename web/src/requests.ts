/**
 * The Requests (--requests) tab, worked out from the stored report
 * with the CLI's own helpers. No React here: tests import it.
 */
import type { NetworkRequest } from '../../src/types';
import { ABSENT, formatBytes } from '../../src/render';
import { requestSummary } from '../../src/rows';

/* -------------------------------- requests -------------------------------- */

export interface RequestFilters {
  party: 'any' | 'first' | 'third';
  sortBy: 'start' | 'size';
  limit?: number;
}

export const DEFAULT_REQUESTS: RequestFilters = { party: 'any', sortBy: 'start' };

export function requestsFromParams(params: URLSearchParams): RequestFilters {
  const filters: RequestFilters = { ...DEFAULT_REQUESTS };
  const party = params.get('party');
  if (party === 'first' || party === 'third') filters.party = party;
  if (params.get('order') === 'size') filters.sortBy = 'size';
  const limit = Number(params.get('limit') ?? NaN);
  if (params.get('limit') !== null && Number.isInteger(limit) && limit >= 0) filters.limit = limit;
  return filters;
}

export function requestsToParams(filters: RequestFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.party !== 'any') params.set('party', filters.party);
  if (filters.sortBy === 'size') params.set('order', 'size');
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  return params;
}

export interface RequestRow {
  url: string;
  start: string;
  end: string;
  type: string;
  priority: string;
  size: string;
  /** Uncompressed size, JSON-only in the CLI. */
  resourceSize: string;
  status: string;
  notFound: boolean;
  preload: boolean;
  party: 'first' | 'third';
  entity?: string;
  mimeType?: string;
}

/** The same rows, in the same order, that renderRequests prints. */
export function requestRows(
  requests: NetworkRequest[] | null | undefined,
  filters: RequestFilters,
): { rows: RequestRow[]; matched: number } {
  const all = requests ?? [];
  let shown = all.filter((request) => filters.party === 'any' || request.party === filters.party);
  if (filters.sortBy === 'size') shown = [...shown].sort((a, b) => (b.transferSize ?? 0) - (a.transferSize ?? 0));
  const matched = shown.length;
  if (filters.limit !== undefined) shown = shown.slice(0, filters.limit);
  const ms = (value: number | undefined) => (value === undefined ? ABSENT : `${Math.round(value)}`);
  return {
    matched,
    rows: shown.map((request) => ({
      url: request.url,
      start: ms(request.startMs),
      end: ms(request.endMs),
      type: request.resourceType ?? ABSENT,
      priority: request.priority ?? ABSENT,
      size: formatBytes(request.transferSize),
      resourceSize: formatBytes(request.resourceSize),
      status: request.statusCode === undefined ? ABSENT : String(request.statusCode),
      notFound: request.statusCode === 404,
      preload: Boolean(request.isLinkPreload),
      party: request.party,
      entity: request.entity,
      mimeType: request.mimeType,
    })),
  };
}

export interface RequestTotals {
  count: number;
  bytes: string;
  first: { count: number; bytes: string };
  third: { count: number; bytes: string };
  notFound: number;
  byType: Array<{ type: string; count: number; bytes: string }>;
}

/** The CLI's REQUESTS summary line, from its own requestSummary. */
export function requestTotals(requests: NetworkRequest[]): RequestTotals {
  const summary = requestSummary(requests);
  return {
    count: summary.count,
    bytes: formatBytes(summary.bytes),
    first: { count: summary.byParty.first.count, bytes: formatBytes(summary.byParty.first.bytes) },
    third: { count: summary.byParty.third.count, bytes: formatBytes(summary.byParty.third.bytes) },
    notFound: requests.filter((request) => request.statusCode === 404).length,
    byType: summary.byType.map((entry) => ({ type: entry.type, count: entry.count, bytes: formatBytes(entry.bytes) })),
  };
}
