/** psi --cleanup: stored reports more than 3 days old go, everything else stays. */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { cleanupReports, reportIdTime } from '../src/cleanup.js';
import { main } from '../src/cli.js';

const NOW = new Date('2026-11-27T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/** A report id measured `days` before NOW. */
function idAgo(days: number, strategy: 'mobile' | 'desktop' = 'mobile'): string {
  const iso = new Date(NOW.getTime() - days * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  return `${iso}-${strategy}`;
}

let dir: string;

async function writeReport(host: string, reportId: string): Promise<void> {
  const folder = path.join(dir, host, reportId);
  await mkdir(folder, { recursive: true });
  for (const file of ['report.json', 'runs.json', 'categories.json']) await writeFile(path.join(folder, file), '{}\n');
}

const listing = async (host: string) => (await readdir(path.join(dir, host))).sort();

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'psi-api-cleanup-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('reportIdTime', () => {
  it('reads the time in a report id and refuses anything else', () => {
    expect(reportIdTime('2026-11-26T06-49-55Z-mobile')?.toISOString()).toBe('2026-11-26T06:49:55.000Z');
    expect(reportIdTime('2026-11-26T06-49-55Z-desktop')).not.toBeNull();
    for (const name of ['seo', 'optimization-log.md', 'stray', '2026-11-26T06-49-55Z', '2026-11-26T06-49-55Z-mobile-seo', '2026-13-40T99-99-99Z-mobile']) {
      expect(reportIdTime(name)).toBeNull();
    }
  });
});

describe('cleanupReports', () => {
  it('deletes every report more than 3 days old across hosts and keeps the rest', async () => {
    const old = [idAgo(10), idAgo(4, 'desktop'), idAgo(3.01)];
    const young = [idAgo(2.99), idAgo(0.5, 'desktop')];
    for (const id of [...old, ...young]) await writeReport('www.guvi.in', id);
    await writeReport('example.com', idAgo(30));

    const result = await cleanupReports({ dataDir: dir, now: NOW });

    expect(result.removed.map((entry) => entry.reportId).sort()).toEqual([...old, idAgo(30)].sort());
    expect(result.failed).toEqual([]);
    expect(result.kept).toBe(2);
    expect(await listing('www.guvi.in')).toEqual(young.sort());
    // An emptied host folder stays.
    expect(await listing('example.com')).toEqual([]);
  });

  it('keeps the seo/ checks, the optimization log and any folder that is not a report id', async () => {
    await writeReport('www.guvi.in', idAgo(5));
    await mkdir(path.join(dir, 'www.guvi.in', 'seo'), { recursive: true });
    await writeFile(path.join(dir, 'www.guvi.in', 'seo', '2026-11-01T10-00-00Z-mobile-seo.json'), '{}\n');
    await writeFile(path.join(dir, 'www.guvi.in', 'optimization-log.md'), '# log\n');
    await mkdir(path.join(dir, 'www.guvi.in', 'stray'));

    const result = await cleanupReports({ dataDir: dir, now: NOW });

    expect(result.removed).toHaveLength(1);
    expect(await listing('www.guvi.in')).toEqual(['optimization-log.md', 'seo', 'stray']);
    expect(await readdir(path.join(dir, 'www.guvi.in', 'seo'))).toEqual(['2026-11-01T10-00-00Z-mobile-seo.json']);
  });

  it('deletes nothing on a dry run but lists what would go', async () => {
    await writeReport('www.guvi.in', idAgo(7));
    const result = await cleanupReports({ dataDir: dir, now: NOW, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.removed.map((entry) => entry.reportId)).toEqual([idAgo(7)]);
    expect(result.removed[0]!.ageDays).toBe(7);
    expect(await listing('www.guvi.in')).toEqual([idAgo(7)]);
  });

  it('finds nothing in an empty or missing data folder', async () => {
    expect(await cleanupReports({ dataDir: dir, now: NOW })).toMatchObject({ removed: [], failed: [], kept: 0 });
    expect(await cleanupReports({ dataDir: path.join(dir, 'missing'), now: NOW })).toMatchObject({ removed: [], kept: 0 });
  });
});

describe('psi --cleanup', () => {
  let out: string[];
  let exit: MockInstance;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['PSI_DATA_DIR', 'NO_COLOR']) saved[key] = process.env[key];
    process.env.PSI_DATA_DIR = dir;
    process.env.NO_COLOR = '1';
    out = [];
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('deletes the old reports and says how many', async () => {
    await writeReport('www.guvi.in', idAgo(4));
    await writeReport('www.guvi.in', idAgo(1));
    expect(await main(['--cleanup'])).toBe(0);
    const text = out.join('');
    expect(text).toContain(`deleted  www.guvi.in/${idAgo(4)}  4 days old`);
    expect(text).toContain('1 deleted, 0 failed, 1 kept');
    expect(await listing('www.guvi.in')).toEqual([idAgo(1)]);
  });

  it('--dry-run --json lists without deleting', async () => {
    await writeReport('www.guvi.in', idAgo(4));
    expect(await main(['--cleanup', '--dry-run', '--json'])).toBe(0);
    const result = JSON.parse(out.join(''));
    expect(result).toMatchObject({ dryRun: true, maxAgeDays: 3, kept: 0 });
    expect(result.removed[0].reportId).toBe(idAgo(4));
    expect(await listing('www.guvi.in')).toEqual([idAgo(4)]);
  });

  it('says so when nothing is old enough', async () => {
    await writeReport('www.guvi.in', idAgo(1));
    expect(await main(['--cleanup'])).toBe(0);
    expect(out.join('')).toContain('nothing older than 3 days');
  });

  it('refuses a url, other options, and --dry-run on its own', async () => {
    await expect(main(['--cleanup', 'https://example.com'])).rejects.toThrow('exit 1');
    await expect(main(['--cleanup', '--desktop'])).rejects.toThrow('exit 1');
    await expect(main(['--dry-run'])).rejects.toThrow('exit 1');
    expect(exit).toHaveBeenCalled();
  });
});

describe('cleanupReports when one folder cannot be deleted', () => {
  it('reports that folder and carries on with the rest', async () => {
    const locked = idAgo(8);
    const free = idAgo(9);
    await writeReport('www.guvi.in', locked);
    await writeReport('www.guvi.in', free);
    const result = await cleanupReports({
      dataDir: dir,
      now: NOW,
      remove: async (folder) => {
        if (folder.endsWith(locked)) throw new Error('EBUSY: resource busy or locked');
        await rm(folder, { recursive: true });
      },
    });
    expect(result.removed.map((entry) => entry.reportId)).toEqual([free]);
    expect(result.failed).toEqual([{ reportId: locked, host: 'www.guvi.in', ageDays: 8, error: 'EBUSY: resource busy or locked' }]);
    expect(await listing('www.guvi.in')).toEqual([locked]);
  });
});
