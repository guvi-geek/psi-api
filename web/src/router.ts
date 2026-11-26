import { useEffect, useState } from 'preact/hooks';

/**
 * Hash routes (#/report/<id>), so UI paths never collide with the API's own
 * /report/:reportId routes and the server only has to serve one index.html.
 */
export type Route =
  | { name: 'home' }
  | { name: 'report'; reportId: string }
  | { name: 'compare'; before?: string; after?: string }
  | { name: 'missing'; path: string };

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const [path = '/', query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'home' };
  if (parts[0] === 'report' && parts[1]) return { name: 'report', reportId: decodeURIComponent(parts[1]) };
  if (parts[0] === 'compare') {
    return { name: 'compare', before: params.get('before') ?? undefined, after: params.get('after') ?? undefined };
  }
  return { name: 'missing', path };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(location.hash));
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export const href = {
  home: () => '#/',
  report: (id: string) => `#/report/${encodeURIComponent(id)}`,
  compare: (before?: string, after?: string) => {
    const params = new URLSearchParams();
    if (before) params.set('before', before);
    if (after) params.set('after', after);
    const query = params.toString();
    return `#/compare${query ? `?${query}` : ''}`;
  },
};
