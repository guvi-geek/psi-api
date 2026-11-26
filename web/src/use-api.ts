import { useEffect, useState } from 'react';
import { api, ApiError } from './api';

/** GET `path` and re-fetch whenever it or `version` changes. */
export function useApi<T>(path: string | null, version = 0) {
  const [state, setState] = useState<{ data?: T; error?: ApiError; loading: boolean }>({ loading: true });
  useEffect(() => {
    if (!path) return;
    let live = true;
    setState((previous) => ({ data: previous.data, loading: true }));
    api<T>(path)
      .then((data) => live && setState({ data, loading: false }))
      .catch((error: ApiError) => live && setState({ error, loading: false }));
    return () => {
      live = false;
    };
  }, [path, version]);
  return state;
}
