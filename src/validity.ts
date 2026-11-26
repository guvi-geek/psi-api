/**
 * Whether a finished report is a measurement an agent may act on.
 *
 * Computed when a report is read, from the report and its stored runs. Nothing
 * here is written back into `report.json`, so older reports gain the check
 * without a rewrite.
 */

import type { AggregatedReport, NetworkRequest, NormalizedReport } from './types.js';
import { pageDocument } from './rows.js';

export interface MeasurementValidity {
  /** False when the loop should discard this report and not ship a fix from it. */
  usable: boolean;
  reasons: string[];
}

const CACHED_RUN = /same analysis timestamp/i;

export function isPageNotFound(run: {
  requests?: NetworkRequest[] | null;
  url: string;
  finalUrl: string;
}): boolean {
  if (!run.requests || run.requests.length === 0) return false;
  const page = pageDocument(run.requests, run.url, run.finalUrl);
  return page?.statusCode === 404;
}

/**
 * A host PSI could not load. Retrying the rest of the batch spends quota on the
 * same answer, which is the failure the guide tells an agent not to sit through.
 */
export function isUnreachableMessage(message: string): boolean {
  return /FAILED_DOCUMENT_REQUEST|ERR_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_ADDRESS_UNREACHABLE/.test(
    message,
  );
}

export function assessMeasurement(input: {
  report: AggregatedReport;
  runs?: NormalizedReport[] | null;
  warnings?: string[];
}): MeasurementValidity {
  const reasons: string[] = [];
  const runs = input.runs ?? [];
  const withRequests = runs.filter((run) => run.requests && run.requests.length > 0);
  const subjects =
    withRequests.length > 0
      ? withRequests
      : input.report.requests && input.report.requests.length > 0
        ? [input.report]
        : [];
  const notFound = subjects.filter((subject) => isPageNotFound(subject)).length;
  if (notFound > 0) {
    reasons.push(
      subjects.length > 1
        ? `The page returned 404 on ${notFound} of ${subjects.length} runs that recorded requests. Do not optimize the error page.`
        : 'The page returned 404. This report describes the error page, not the page you asked to measure.',
    );
  }

  const stamps = new Set(runs.map((run) => run.fetchTime).filter((stamp) => stamp.length > 0));
  const cached =
    (input.warnings ?? []).some((warning) => CACHED_RUN.test(warning)) ||
    (runs.length > 1 && stamps.size === 1);
  if (cached) {
    reasons.push(
      'Every run shares one analysis timestamp, so PSI served a cached report. Do not judge a change on it.',
    );
  }

  // A spread in the runs' CPU benchmark index is not a reason to discard a report:
  // PSI picks the machine per run and the caller cannot choose it, so nearly every
  // report would be rejected. Each run's benchmarkIndex stays in runs.json.

  return { usable: reasons.length === 0, reasons };
}
