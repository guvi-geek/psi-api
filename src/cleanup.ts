/**
 * `psi --cleanup`: delete the CLI's stored reports that are more than 3 days old.
 *
 * Files only: the web UI's reports in MongoDB are never touched, and nothing
 * here deletes from a database. A report's age is the time in its id
 * (2026-11-26T06-49-55Z-mobile), because a reanalysis rewrites the files and
 * moves their dates. Only a folder whose name is exactly a report id is ever
 * deleted, so a host folder, the old `seo/` checks, `optimization-log.md` and
 * any stray folder stay.
 */
import { lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { getDataDir } from './storage.js';

export const CLEANUP_MAX_AGE_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

// The random suffix is optional: ids made before it was added stay valid.
const REPORT_ID = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z-(?:mobile|desktop)(?:-[0-9a-f]{6})?$/;

/** When a report was measured, read from its id. Null for anything that is not a report id. */
export function reportIdTime(reportId: string): Date | null {
  const match = REPORT_ID.exec(reportId);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const time = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  return Number.isNaN(time.getTime()) ? null : time;
}

export interface CleanupEntry {
  reportId: string;
  host: string;
  /** Age in days at the time of the cleanup, one decimal. */
  ageDays: number;
  /** Set when the folder could not be deleted. */
  error?: string;
}

export interface CleanupResult {
  dryRun: boolean;
  maxAgeDays: number;
  /** Deleted, or with dryRun, the ones that would be. */
  removed: CleanupEntry[];
  failed: CleanupEntry[];
  /** Reports young enough to stay. */
  kept: number;
}

export interface CleanupOptions {
  dataDir?: string;
  now?: Date;
  maxAgeDays?: number;
  dryRun?: boolean;
  /** Test seam: how a folder is deleted. */
  remove?: (folder: string) => Promise<void>;
}

async function subfolders(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

export async function cleanupReports(options: CleanupOptions = {}): Promise<CleanupResult> {
  const dataDir = path.resolve(options.dataDir ?? getDataDir());
  const now = (options.now ?? new Date()).getTime();
  const maxAgeDays = options.maxAgeDays ?? CLEANUP_MAX_AGE_DAYS;
  const dryRun = options.dryRun ?? false;
  const remove = options.remove ?? ((folder: string) => rm(folder, { recursive: true }));
  const result: CleanupResult = { dryRun, maxAgeDays, removed: [], failed: [], kept: 0 };

  for (const host of await subfolders(dataDir)) {
    for (const reportId of await subfolders(path.join(dataDir, host))) {
      const measured = reportIdTime(reportId);
      if (!measured) continue;
      const ageMs = now - measured.getTime();
      if (ageMs <= maxAgeDays * DAY_MS) {
        result.kept += 1;
        continue;
      }
      const entry: CleanupEntry = { reportId, host, ageDays: Math.round((ageMs / DAY_MS) * 10) / 10 };
      const dir = path.join(dataDir, host, reportId);
      try {
        // Never follow a link out of data/: only a real folder at data/<host>/<reportId> goes.
        if (!(await lstat(dir)).isDirectory()) continue;
        if (!dryRun) await remove(dir);
        result.removed.push(entry);
      } catch (error) {
        result.failed.push({ ...entry, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  const newestFirst = (a: CleanupEntry, b: CleanupEntry) => b.reportId.localeCompare(a.reportId);
  result.removed.sort(newestFirst);
  result.failed.sort(newestFirst);
  return result;
}
