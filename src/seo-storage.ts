/** Saving, loading and listing SEO checks: data/<host>/seo/<seoId>.json. */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isSeoId, type SeoCheck, type SeoSummary } from './seo.js';
import { dataDirForHost, getDataDir } from './storage.js';
import type { Strategy } from './types.js';

const SEO_DIR = 'seo';

function assertSeoId(seoId: string): void {
  if (!isSeoId(seoId)) throw new Error(`invalid seoId: ${seoId}`);
}

/** data/<host>/seo/<seoId>.json. Reports live in data/<host>/<reportId>/, so the two never meet. */
export async function saveSeoCheck(check: SeoCheck, dataDir = getDataDir()): Promise<string> {
  assertSeoId(check.seoId);
  const dir = path.join(dataDirForHost(check.url, dataDir), SEO_DIR);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${check.seoId}.json`);
  await writeFile(file, `${JSON.stringify(check, null, 2)}\n`, 'utf8');
  return file;
}

async function hostsIn(dataDir: string): Promise<string[]> {
  try {
    return (await readdir(dataDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

export async function loadSeoCheck(seoId: string, dataDir = getDataDir()): Promise<SeoCheck | null> {
  assertSeoId(seoId);
  for (const host of await hostsIn(dataDir)) {
    try {
      return JSON.parse(await readFile(path.join(dataDir, host, SEO_DIR, `${seoId}.json`), 'utf8')) as SeoCheck;
    } catch {
      /* not here, keep looking */
    }
  }
  return null;
}

/** Saved checks, newest first. Filter by page and device to find the latest check of one page. */
export async function listSeoChecks(
  filter: { url?: string; strategy?: Strategy } = {},
  dataDir = getDataDir(),
): Promise<SeoSummary[]> {
  const found: SeoSummary[] = [];
  for (const host of await hostsIn(dataDir)) {
    let files: string[];
    try {
      files = (await readdir(path.join(dataDir, host, SEO_DIR))).filter((name) => isSeoId(name.replace(/\.json$/, '')));
    } catch {
      continue;
    }
    for (const name of files) {
      try {
        const check = JSON.parse(await readFile(path.join(dataDir, host, SEO_DIR, name), 'utf8')) as SeoCheck;
        if (filter.url && check.url !== filter.url) continue;
        if (filter.strategy && check.strategy !== filter.strategy) continue;
        found.push({
          seoId: check.seoId,
          host,
          url: check.url,
          strategy: check.strategy,
          fetchedAt: check.fetchedAt,
          score: check.score,
          counts: check.counts,
        });
      } catch {
        /* a broken file is skipped, as listReports skips a folder without a report */
      }
    }
  }
  return found.sort((a, b) => b.seoId.localeCompare(a.seoId));
}
