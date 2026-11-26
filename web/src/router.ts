import { useEffect, useState } from 'react';

/**
 * Hash routes (#/report/<id>), so UI paths never collide with the API's own
 * /report/:reportId routes and the server only has to serve one index.html.
 */
export type Route =
  | { name: 'home' }
  | { name: 'report'; reportId: string }
  | { name: 'run'; jobId: string }
  | { name: 'compare'; before?: string; after?: string }
  | { name: 'missing'; path: string };

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const [path = '/', query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'home' };
  if (parts[0] === 'report' && parts[1]) return { name: 'report', reportId: decodeURIComponent(parts[1]) };
  if (parts[0] === 'run' && parts[1]) return { name: 'run', jobId: decodeURIComponent(parts[1]) };
  if (parts[0] === 'compare') {
    return { name: 'compare', before: params.get('before') ?? undefined, after: params.get('after') ?? undefined };
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
  report: (id: string) => `#/report/${encodeURIComponent(id)}`,
  run: (jobId: string) => `#/run/${encodeURIComponent(jobId)}`,
  compare: (before?: string, after?: string) => {
    const params = new URLSearchParams();
    if (before) params.set('before', before);
    if (after) params.set('after', after);
    const query = params.toString();
    return `#/compare${query ? `?${query}` : ''}`;
  },
};
