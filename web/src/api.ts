import type { JobProgress, JobStatus, RunRequest, Stat, Strategy } from './run';

/** Thin client for the psi-api server. Every error comes back as { code, message }. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
    });
  } catch {
    throw new ApiError(0, 'UNREACHABLE', 'The psi-api server is not responding. Start it with npm run ui.');
  }
  const body = (await response.json().catch(() => null)) as
    | (T & { error?: { code: string; message: string } })
    | null;
  // Only the status says a request failed: the server always sends its errors as
  // non-2xx. A 200 body can carry its own `error` field, such as a failed job.
  if (!response.ok) {
    const error = body?.error ?? { code: 'HTTP_' + response.status, message: response.statusText };
    throw new ApiError(response.status, error.code, error.message);
  }
  return body as T;
}

export interface Health {
  status: string;
  apiKeyConfigured: boolean;
  activeJobs: number;
}

export interface Job {
  id: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  request: { url: string; strategy: Strategy; runs: number; stat: Stat };
  progress?: JobProgress[];
  save?: boolean;
  error?: { code: string; message: string };
  result?: {
    reportId: string;
    runsRequested: number;
    runsSucceeded: number;
    headline: { score: number };
    targets?: { gaps: Array<{ meets: boolean }> };
  };
}

/** Starts a measurement as a background job. Costs `runs` PSI calls. */
export function startRun(request: RunRequest): Promise<{ jobId: string; status: JobStatus }> {
  return api('/report', { method: 'POST', body: JSON.stringify({ ...request, async: true }) });
}

export type Budget = { score: number; lcp: number; tbt: number; cls: number; fcp: number; speedIndex: number };
export type Targets = { mobile: Budget; desktop: Budget };
