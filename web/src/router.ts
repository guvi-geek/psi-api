import { useEffect, useState } from 'react';

/**
 * Hash routes (#/report/<id>), so UI paths never collide with the API's own
 * /report/:reportId routes and the server only has to serve one index.html.
 */
export type Route =
  | { name: 'home' }
  | { name: 'report'; reportId: string; params: URLSearchParams }
  | { name: 'run'; jobId: string }
  | { name: 'missing'; path: string };

function decode(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const [path = '/', query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'home' };
  if (parts[0] === 'report' && parts[1]) {
    const reportId = decode(parts[1]);
    return reportId ? { name: 'report', reportId, params } : { name: 'missing', path };
  }
  if (parts[0] === 'run' && parts[1]) {
    const jobId = decode(parts[1]);
    return jobId ? { name: 'run', jobId } : { name: 'missing', path };
  }
  return { name: 'missing', path };
}

/**
 * `null` until mounted: the page is pre-rendered at build time, where there is
 * no location, so the hash is read only in the browser.
 */
export function useRoute(): Route | null {
  const [route, setRoute] = useState<Route | null>(null);
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(location.hash));
    onChange();
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export const href = {
  home: () => '#/',
  /** `params` carries the tab and its state, such as ?tab=findings&metric=lcp. */
  report: (id: string, params?: URLSearchParams) => {
    const query = params?.toString();
    return `#/report/${encodeURIComponent(id)}${query ? `?${query}` : ''}`;
  },
  run: (jobId: string) => `#/run/${encodeURIComponent(jobId)}`,
};
