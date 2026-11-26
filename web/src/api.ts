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
  if (!response.ok || body?.error) {
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

export type Budget = { score: number; lcp: number; tbt: number; cls: number; fcp: number; speedIndex: number };
export type Targets = { mobile: Budget; desktop: Budget };
