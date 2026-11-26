/** The web UI's pure logic: form checks, the run grid, and the report list. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../web/src/api.js';
import { validateTargetUrl } from '../src/psiClient.js';
import { parseRoute } from '../web/src/router.js';
import {
  columnsOf,
  formatElapsed,
  formatWhen,
  groupReports,
  measuredAt,
  isPrivateHost,
  normalizeUrl,
  parseRuns,
  pathOf,
  scoreBand,
  slotsFor,
  verdictOf,
  type ReportRow,
} from '../web/src/run.js';

describe('normalizeUrl', () => {
  it('keeps an http(s) address and adds https:// to a bare host', () => {
    expect(normalizeUrl(' https://example.com/a ')).toEqual({ url: 'https://example.com/a' });
    expect(normalizeUrl('http://example.com')).toEqual({ url: 'http://example.com/' });
    expect(normalizeUrl('www.guvi.in/zen-class/')).toEqual({ url: 'https://www.guvi.in/zen-class/' });
  });

  it('explains an empty, malformed or non-web address', () => {
    expect(normalizeUrl('  ').error).toMatch(/Enter the page address/);
    expect(normalizeUrl('http://').error).toMatch(/not a page address/);
    expect(normalizeUrl('file:///app/index.html').error).toMatch(/Only http and https/);
    expect(normalizeUrl('ftp://example.com').error).toMatch(/Only http and https/);
  });
});

describe('isPrivateHost', () => {
  it('agrees with the server, which warns about the same hosts', () => {
    const urls = [
      'http://localhost:3000/', 'http://127.0.0.1/', 'http://10.1.2.3/', 'http://192.168.0.9/',
      'http://172.16.0.1/', 'http://172.31.255.255/', 'http://172.32.0.1/', 'http://169.254.1.1/',
      'http://[::1]/', 'http://[fd12:3456::1]/', 'http://[fe80::1]/', 'http://printer.local/',
      'http://api.internal/', 'http://site.test/', 'http://app.localhost/', 'https://example.com/',
      'https://www.guvi.in/zen-class/', 'https://localhost.example.com/', 'https://8.8.8.8/',
    ];
    for (const url of urls) {
      expect(isPrivateHost(url), url).toBe(validateTargetUrl(url).warnings.length > 0);
    }
    expect(isPrivateHost('http://localhost:3000/')).toBe(true);
    expect(isPrivateHost('https://example.com/')).toBe(false);
  });
});

describe('parseRuns', () => {
  it('accepts 1 to 40 and nothing else, like --runs', () => {
    expect(parseRuns('1')).toEqual({ runs: 1 });
    expect(parseRuns(40)).toEqual({ runs: 40 });
    for (const bad of ['0', '41', '2.5', 'ten', '']) expect(parseRuns(bad).error, bad).toMatch(/1 to 40/);
  });
});

describe('slotsFor', () => {
  it('fills slots in finish order and spins the next one while running', () => {
    const slots = slotsFor(
      [
        { run: 3, ok: true, score: 87.4 },
        { run: 1, ok: false, error: 'HTTP 500' },
      ],
      4,
      'running',
    );
    expect(slots).toEqual([
      { n: 1, state: 'done', score: 87 },
      { n: 2, state: 'fail', error: 'HTTP 500' },
      { n: 3, state: 'active' },
      { n: 4, state: 'waiting' },
    ]);
  });

  it('gives a cached attempt no slot, as the CLI does', () => {
    const slots = slotsFor(
      [
        { run: 1, ok: false, cached: true, error: 'cached, retrying' },
        { run: 1, ok: true, score: 90 },
      ],
      2,
      'running',
    );
    expect(slots.map((slot) => slot.state)).toEqual(['done', 'active']);
  });

  it('spins the first slot before any result, and nothing once the job ends', () => {
    expect(slotsFor([], 3, 'queued')[0]!.state).toBe('active');
    expect(slotsFor([], 3, 'failed').every((slot) => slot.state === 'waiting')).toBe(true);
  });
});

describe('grid helpers', () => {
  it('splits into columns of five', () => {
    expect(columnsOf([1, 2, 3, 4, 5, 6, 7]).map((column) => column.length)).toEqual([5, 2]);
  });

  it('uses the Lighthouse score bands', () => {
    expect([100, 90, 89, 50, 49, 0].map(scoreBand)).toEqual(['good', 'good', 'warn', 'warn', 'bad', 'bad']);
  });

  it('formats elapsed time as m:ss', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(65_400)).toBe('1:05');
    expect(formatElapsed(-5)).toBe('0:00');
  });
});

const row = (overrides: Partial<ReportRow>): ReportRow => ({
  reportId: '2026-11-23T13-13-24Z-mobile',
  host: 'www.guvi.in',
  url: 'https://www.guvi.in/',
  strategy: 'mobile',
  stat: 'median',
  generatedAt: '2026-11-23T13:13:24.000Z',
  runsRequested: 10,
  runsSucceeded: 10,
  score: 93,
  lcp: 3151,
  meetsTarget: false,
  targetsFailing: 2,
  targetsTotal: 6,
  ...overrides,
});

describe('groupReports', () => {
  const reports = [
    row({ reportId: 'c', host: 'a.com', url: 'https://a.com/x' }),
    row({ reportId: 'b', host: 'b.com', url: 'https://b.com/' }),
    row({ reportId: 'a', host: 'a.com', url: 'https://a.com/', strategy: 'desktop' }),
  ];

  it('groups by host and keeps newest first inside each group', () => {
    const groups = groupReports(reports);
    expect(groups.map((group) => group.host)).toEqual(['a.com', 'b.com']);
    expect(groups[0]!.reports.map((report) => report.reportId)).toEqual(['c', 'a']);
  });

  it('filters on URL, id or strategy, case-insensitive', () => {
    expect(groupReports(reports, 'B.COM').map((group) => group.host)).toEqual(['b.com']);
    expect(groupReports(reports, 'desktop')[0]!.reports.map((report) => report.reportId)).toEqual(['a']);
    expect(groupReports(reports, 'nothing-matches')).toEqual([]);
  });
});

describe('measuredAt', () => {
  it('reads the measurement time from the report id, which a re-analysis keeps', () => {
    expect(measuredAt('2026-11-23T13-13-24Z-mobile', '2026-11-26T08:00:00.000Z')).toBe('2026-11-23T13:13:24Z');
    expect(measuredAt('2026-11-26T06-34-05Z-desktop', 'x')).toBe('2026-11-26T06:34:05Z');
  });

  it('falls back to generatedAt for an id it cannot read', () => {
    expect(measuredAt('custom-id', '2026-11-26T08:00:00.000Z')).toBe('2026-11-26T08:00:00.000Z');
    expect(measuredAt('2026-13-45T99-99-99Z-mobile', 'fallback')).toBe('fallback');
  });
});

describe('parseRoute', () => {
  it('shows not found for a malformed escape instead of throwing', () => {
    expect(parseRoute('#/report/%E0')).toEqual({ name: 'missing', path: '/report/%E0' });
    expect(parseRoute('#/run/%')).toEqual({ name: 'missing', path: '/run/%' });
    expect(parseRoute('#/report/2026-11-23T13-13-24Z-mobile')).toMatchObject({
      name: 'report',
      reportId: '2026-11-23T13-13-24Z-mobile',
    });
  });
});

describe('report row text', () => {
  it('shows the path under the host', () => {
    expect(pathOf('https://www.guvi.in/zen-class/devops-course/')).toBe('/zen-class/devops-course/');
    expect(pathOf('https://example.com')).toBe('/');
    expect(pathOf('https://example.com/a?b=1')).toBe('/a?b=1');
  });

  it('says how long ago, then falls back to a date', () => {
    const now = Date.parse('2026-11-26T12:00:00Z');
    expect(formatWhen('2026-11-26T11:59:40Z', now)).toBe('Just now');
    expect(formatWhen('2026-11-26T11:48:00Z', now)).toBe('12 min ago');
    expect(formatWhen('2026-11-26T09:00:00Z', now)).toBe('3 h ago');
    expect(formatWhen('2026-11-20T09:00:00Z', now)).toMatch(/2026/);
    expect(formatWhen('not a date', now)).toBe('');
  });

  it('uses the CLI verdict: FAIL only when more than half the targets fail', () => {
    expect(verdictOf({ targetsFailing: 2, targetsTotal: 6 })).toBe('PASS');
    expect(verdictOf({ targetsFailing: 3, targetsTotal: 6 })).toBe('PASS');
    expect(verdictOf({ targetsFailing: 4, targetsTotal: 6 })).toBe('FAIL');
  });
});

describe('api client', () => {
  const stubFetch = (status: number, body: unknown) =>
    vi.stubGlobal('fetch', async () => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: 'status text',
      json: async () => body,
    }));
  afterEach(() => vi.unstubAllGlobals());

  it('returns a 200 body even when it carries its own error field, such as a failed job', async () => {
    const failedJob = { id: 'job_1', status: 'failed', error: { code: 'INSUFFICIENT_RUNS', message: 'Only 0 of 10' } };
    stubFetch(200, failedJob);
    await expect(api('/jobs/job_1')).resolves.toEqual(failedJob);
  });

  it('throws the server error for a non-2xx status', async () => {
    stubFetch(404, { error: { code: 'NOT_FOUND', message: 'no job "x"' } });
    await expect(api('/jobs/x')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND', message: 'no job "x"' });
  });

  it('says the server is not responding when fetch itself fails', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    await expect(api('/health')).rejects.toBeInstanceOf(ApiError);
    await expect(api('/health')).rejects.toMatchObject({ code: 'UNREACHABLE' });
  });
});
