'use client';

import { App } from '../src/app';

// One static page. The app routes with the URL hash (#/report/<id>), so the
// Fastify server only serves index.html and no API path is ever shadowed.
export default function Page() {
  return <App />;
}
