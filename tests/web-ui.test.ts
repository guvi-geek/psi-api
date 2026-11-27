/** The server serves the built UI at `/` without shadowing any API route. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { FileStore } from '../src/report-store.js';

let root: string;
let app: FastifyInstance;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'psi-api-web-'));
  const webDir = path.join(root, 'dist');
  await mkdir(path.join(webDir, '_next', 'static', 'chunks'), { recursive: true });
  await writeFile(path.join(webDir, 'index.html'), '<!doctype html><title>PSI - API</title>');
  await writeFile(path.join(webDir, '_next', 'static', 'chunks', 'app-abc.js'), 'console.log(1)');
  await writeFile(path.join(webDir, '_next', 'unhashed.js'), 'console.log(2)');
  await writeFile(path.join(webDir, '_next', 'notes.txt'), 'not a web asset');
  await writeFile(path.join(root, 'secret.json'), '{"leak":true}');
  // A servable type outside _next: only the path check can stop this one.
  await writeFile(path.join(root, 'outside.js'), 'leak()');
  await writeFile(path.join(webDir, 'outside.js'), 'leak()');
  app = buildServer({ store: new FileStore(), webDir });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

describe('web UI serving', () => {
  it('serves index.html at / without long caching', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.body).toContain('PSI - API');
  });

  it('serves hashed /_next/static files with their type and an immutable cache', async () => {
    const response = await app.inject({ method: 'GET', url: '/_next/static/chunks/app-abc.js' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/javascript/);
    expect(response.headers['cache-control']).toContain('immutable');
  });

  it('does not cache /_next files outside static for good', async () => {
    const response = await app.inject({ method: 'GET', url: '/_next/unhashed.js' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-cache');
  });

  it('refuses paths outside _next, unknown types and missing files', async () => {
    for (const url of ['/_next/..%2Foutside.js', '/_next/..%2F..%2Foutside.js', '/_next/..%2F..%2Fsecret.json', '/_next/static/..%2F..%2F..%2Fsecret.json', '/_next/notes.txt', '/_next/static/nope.js']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(404);
      expect(response.body).not.toContain('leak');
    }
  });

  it('leaves the API routes alone', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).json().status).toBe('ok');
    expect((await app.inject({ method: 'GET', url: '/report/does-not-exist' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/reports' })).statusCode).toBe(200);
  });

  it('serves nothing at / when the UI has not been built', async () => {
    const bare = buildServer({ store: new FileStore(), webDir: path.join(root, 'missing') });
    await bare.ready();
    try {
      expect((await bare.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
      expect((await bare.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    } finally {
      await bare.close();
    }
  });
});
