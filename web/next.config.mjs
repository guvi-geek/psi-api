import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';
import { fileURLToPath } from 'node:url';

// The repo root owns node_modules; the web app has no package.json of its own.
const root = fileURLToPath(new URL('..', import.meta.url));
// Not PORT: `next dev -p` sets PORT to its own port, which would forward the API to itself.
const api = process.env.PSI_API_URL ?? 'http://127.0.0.1:3939';

// Every API route the Fastify server owns. In dev, Next forwards these to `npm run dev`.
const API_PATHS = ['/health', '/report', '/reports', '/compare', '/reanalyze', '/targets', '/jobs', '/insights'];

/**
 * Production: a static export in web/out, served by the Fastify server at `/`,
 * so `npm run ui` is still one process and one port.
 * Dev: `next dev` with the API forwarded, because a static export has no rewrites.
 */
export default function config(phase) {
  /** @type {import('next').NextConfig} */
  const base = {
    reactStrictMode: true,
    poweredByHeader: false,
    // Next 16 writes an AGENTS.md into the app folder on dev start; this repo keeps its own docs.
    agentRules: false,
    outputFileTracingRoot: root,
    /**
     * Built with webpack (`--webpack` in package.json), not Turbopack, for one
     * reason: the UI imports the CLI's own helpers from src/ (render, readout,
     * rows) so the page and the terminal print the same numbers, and src/ uses
     * Node ESM specifiers (`./types.js` for types.ts). Webpack maps those with
     * extensionAlias; Turbopack in Next 16.4 cannot.
     */
    webpack(webpackConfig) {
      webpackConfig.resolve.extensionAlias = {
        ...webpackConfig.resolve.extensionAlias,
        '.js': ['.ts', '.tsx', '.js'],
      };
      return webpackConfig;
    },
  };
  if (phase === PHASE_DEVELOPMENT_SERVER) {
    return {
      ...base,
      async rewrites() {
        return API_PATHS.flatMap((path) => [
          { source: path, destination: `${api}${path}` },
          { source: `${path}/:rest*`, destination: `${api}${path}/:rest*` },
        ]);
      },
    };
  }
  return { ...base, output: 'export', images: { unoptimized: true } };
}
