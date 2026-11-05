import { describe, expect, it } from 'vitest';
import { CACHE_ATTEMPTS_PER_RUN, InsufficientRunsError, runReport } from '../src/runner.js';
import { PSI_ERROR_BODY, fakeResponse, fixtureRaw } from './helpers.js';

/** A fetch stand-in that succeeds `ok` times, then always fails. */
function flakyFetch(ok: number, total: number, scoreOf: (i: number) => number) {
  const calls: number[] = [];
  const impl = (async () => {
    const index = calls.length;
    calls.push(index);
    if (index < ok) {
      const raw = JSON.parse(JSON.stringify(fixtureRaw)) as {
        lighthouseResult: { categories: { performance: { score: number } }; fetchTime: string };
      };
      raw.lighthouseResult.categories.performance.score = scoreOf(index) / 100;
      raw.lighthouseResult.fetchTime = `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`;
      return fakeResponse(raw);
    }
    return fakeResponse(PSI_ERROR_BODY, { status: 429 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const noSleep = async () => {};

const targets = {
  mobile: { score: 90, lcp: 2500, tbt: 200, cls: 0.1, fcp: 1800, speedIndex: 3400 },
  desktop: { score: 90, lcp: 1800, tbt: 150, cls: 0.1, fcp: 1200, speedIndex: 2400 },
};

describe('runReport', () => {
  it('aggregates every successful run and reports both counts', async () => {
    const { impl } = flakyFetch(4, 4, (i) => 50 + i * 10);
    const result = await runReport({
      url: 'https://example.com/',
      runs: 4,
      save: false,
      fetchImpl: impl,
      sleepImpl: noSleep,
      targets,
    });

    expect(result.report.runsRequested).toBe(4);
    expect(result.report.runsSucceeded).toBe(4);
    expect(result.report.headline.score).toBe(65);
    expect(result.runs).toHaveLength(4);
  });

  it('continues past failures while at least 60% succeed', async () => {
    // 4 succeed out of 5 -> 80% >= 60%.
    const { impl } = flakyFetch(4, 5, () => 72);
    const result = await runReport({
      url: 'https://example.com/',
      runs: 5,
      save: false,
      fetchImpl: impl,
      sleepImpl: noSleep,
      targets,
    });

    expect(result.report.runsSucceeded).toBe(4);
    expect(result.report.runsRequested).toBe(5);
    expect(result.report.errors).toHaveLength(1);
    expect(result.report.errors[0]).toMatchObject({ run: 5 });
  });

  it('throws when fewer than 60% of runs succeed', async () => {
    // 2 of 5 -> 40% < 60%.
    const { impl } = flakyFetch(2, 5, () => 70);
    await expect(
      runReport({ url: 'https://example.com/', runs: 5, save: false, fetchImpl: impl, sleepImpl: noSleep, targets }),
    ).rejects.toBeInstanceOf(InsufficientRunsError);
  });

  it('throws when every run fails', async () => {
    const { impl } = flakyFetch(0, 3, () => 0);
    await expect(
      runReport({ url: 'https://example.com/', runs: 3, save: false, fetchImpl: impl, sleepImpl: noSleep, targets }),
    ).rejects.toBeInstanceOf(InsufficientRunsError);
  });

  it('clamps the run count to the allowed maximum', async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      const raw = JSON.parse(JSON.stringify(fixtureRaw)) as { lighthouseResult: { fetchTime: string } };
      raw.lighthouseResult.fetchTime = `2026-01-01T00:00:${String(calls).padStart(2, '0')}.000Z`;
      return fakeResponse(raw);
    }) as unknown as typeof fetch;

    await runReport({ url: 'https://example.com/', runs: 999, save: false, fetchImpl: impl, sleepImpl: noSleep, targets });
    expect(calls).toBe(40);
  });

  it('rejects an unreachable url before spending any quota', async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return fakeResponse(fixtureRaw);
    }) as unknown as typeof fetch;

    await expect(
      runReport({ url: 'file:///app/index.html', save: false, fetchImpl: impl, sleepImpl: noSleep, targets }),
    ).rejects.toThrow(/file: URLs are not supported/);
    expect(calls).toBe(0);
  });

  it('returns a warning for a private host but still attempts the run', async () => {
    const { impl } = flakyFetch(1, 1, () => 10);
    const result = await runReport({
      url: 'http://localhost:5173/',
      runs: 1,
      save: false,
      fetchImpl: impl,
      sleepImpl: noSleep,
      targets,
    });
    expect(result.warnings[0]).toMatch(/cannot reach/);
  });

  it('honours the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      const raw = JSON.parse(JSON.stringify(fixtureRaw)) as { lighthouseResult: { fetchTime: string } };
      raw.lighthouseResult.fetchTime = `2026-01-01T00:00:${String(calls).padStart(2, '0')}.000Z`;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return fakeResponse(raw);
    }) as unknown as typeof fetch;

    await runReport({
      url: 'https://example.com/',
      runs: 8,
      concurrency: 3,
      save: false,
      fetchImpl: impl,
      sleepImpl: noSleep,
      targets,
    });

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('scores the report against the strategy targets', async () => {
    const { impl } = flakyFetch(3, 3, () => 92);
    const result = await runReport({
      url: 'https://example.com/',
      runs: 3,
      save: false,
      fetchImpl: impl,
      sleepImpl: noSleep,
      targets,
    });
    expect(result.report.targets.meetsTarget).toBe(false); // lcp 3210 is over budget
    expect(result.report.targets.gaps.find((gap) => gap.metric === 'score')?.meets).toBe(true);
  });

  it('generates a sortable report id', async () => {
    const { impl } = flakyFetch(1, 1, () => 50);
    const result = await runReport({ url: 'https://example.com/', runs: 1, save: false, fetchImpl: impl, sleepImpl: noSleep, targets });
    expect(result.report.reportId).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-mobile$/);
  });
});

describe('cached-run detection', () => {
  it('refuses a report when every run is the same cached analysis', async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      const raw = JSON.parse(JSON.stringify(fixtureRaw)) as { lighthouseResult: { fetchTime: string } };
      raw.lighthouseResult.fetchTime = '2026-01-01T00:00:00.000Z';
      return fakeResponse(raw);
    }) as unknown as typeof fetch;

    await expect(
      runReport({
        url: 'https://example.com/',
        runs: 4,
        save: false,
        fetchImpl: impl,
        sleepImpl: noSleep,
        targets,
      }),
    ).rejects.toThrow(/cached report/);
    // The first timestamp is a real sample. Each later slot retries, then is dropped.
    expect(calls).toBe(1 + 3 * CACHE_ATTEMPTS_PER_RUN);
  });

  it('retries a cached run and keeps only distinct timestamps', async () => {
    let call = 0;
    const finished: string[] = [];
    const impl = (async () => {
      call += 1;
      const stamp = call <= 2 ? '2026-01-01T00:00:00.000Z' : `2026-01-01T00:00:0${call}.000Z`;
      const raw = JSON.parse(JSON.stringify(fixtureRaw)) as { lighthouseResult: { fetchTime: string } };
      raw.lighthouseResult.fetchTime = stamp;
      return fakeResponse(raw);
    }) as unknown as typeof fetch;

    const result = await runReport({
      url: 'https://example.com/',
      runs: 4,
      save: false,
      fetchImpl: impl,
      sleepImpl: noSleep,
      targets,
      onRunFinished: (info) => {
        if (info.cached) finished.push('cached');
      },
    });

    expect(finished).toContain('cached');
    expect(result.report.runsSucceeded).toBe(4);
    expect(new Set(result.runs.map((run) => run.fetchTime)).size).toBe(4);
    expect(result.warnings.join(' ')).not.toMatch(/distinct measurements|cached/i);
  });

  it('drops a slot that stays cached and still reports the uncached runs', async () => {
    let call = 0;
    const impl = (async () => {
      call += 1;
      // Run 1 is fresh. The next slot repeats that timestamp until it gives up,
      // then later slots are fresh again. Concurrency 1 keeps that order.
      const stamp =
        call === 1 || call > 1 + CACHE_ATTEMPTS_PER_RUN
          ? `2026-01-01T00:00:0${call}.000Z`
          : '2026-01-01T00:00:01.000Z';
      const raw = JSON.parse(JSON.stringify(fixtureRaw)) as { lighthouseResult: { fetchTime: string } };
      raw.lighthouseResult.fetchTime = stamp;
      return fakeResponse(raw);
    }) as unknown as typeof fetch;

    const result = await runReport({
      url: 'https://example.com/',
      runs: 5,
      concurrency: 1,
      save: false,
      fetchImpl: impl,
      sleepImpl: noSleep,
      targets,
    });

    expect(result.report.runsSucceeded).toBe(4);
    expect(result.report.errors).toEqual([{ run: 2, message: 'PSI served a cached report' }]);
    expect(new Set(result.runs.map((run) => run.fetchTime)).size).toBe(result.runs.length);
  });

  it('stays silent when every run is genuinely distinct', async () => {
    let call = 0;
    const impl = (async () => {
      call += 1;
      const raw = JSON.parse(JSON.stringify(fixtureRaw)) as { lighthouseResult: { fetchTime: string } };
      raw.lighthouseResult.fetchTime = `2026-01-01T00:00:0${call}.000Z`;
      return fakeResponse(raw);
    }) as unknown as typeof fetch;

    const result = await runReport({
      url: 'https://example.com/',
      runs: 3,
      save: false,
      fetchImpl: impl,
      sleepImpl: noSleep,
      targets,
    });

    expect(result.warnings).toEqual([]);
  });

  it('gives each run its own cache-busting param', async () => {
    const requested: string[] = [];
    const impl = (async (input: string) => {
      requested.push(new URL(String(input)).searchParams.get('url') ?? '');
      const raw = JSON.parse(JSON.stringify(fixtureRaw)) as { lighthouseResult: { fetchTime: string } };
      raw.lighthouseResult.fetchTime = `2026-01-01T00:00:0${requested.length}.000Z`;
      return fakeResponse(raw);
    }) as unknown as typeof fetch;

    await runReport({
      url: 'https://example.com/',
      runs: 3,
      save: false,
      fetchImpl: impl,
      sleepImpl: noSleep,
      targets,
    });

    expect(new Set(requested).size).toBe(3);
    expect(requested.every((u) => u.startsWith('https://example.com/?psi_nonce='))).toBe(true);
  });
});

describe('early stop', () => {
  function documentFetch(status: number) {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      const raw = JSON.parse(JSON.stringify(fixtureRaw)) as {
        lighthouseResult: { fetchTime: string; audits: Record<string, unknown> };
      };
      raw.lighthouseResult.fetchTime = `2026-01-01T00:00:${String(calls).padStart(2, '0')}.000Z`;
      raw.lighthouseResult.audits['network-requests'] = {
        details: {
          type: 'table',
          items: [
            {
              url: 'https://example.com/',
              resourceType: 'Document',
              statusCode: status,
              transferSize: 1000,
            },
          ],
        },
      };
      return fakeResponse(raw);
    }) as unknown as typeof fetch;
    return { impl, get calls() { return calls; } };
  }

  it('does not send the rest of the batch when the page is 404', async () => {
    const fetch = documentFetch(404);
    const result = await runReport({
      url: 'https://example.com/',
      runs: 6,
      save: false,
      fetchImpl: fetch.impl,
      sleepImpl: noSleep,
      targets,
    });
    expect(fetch.calls).toBe(1);
    expect(result.report.runsSucceeded).toBe(1);
    expect(result.warnings.join(' ')).toMatch(/404/);
    expect(result.warnings.join(' ')).toMatch(/not sent/);
  });

  it('still measures every run when the document loads', async () => {
    const fetch = documentFetch(200);
    await runReport({
      url: 'https://example.com/',
      runs: 3,
      save: false,
      fetchImpl: fetch.impl,
      sleepImpl: noSleep,
      targets,
    });
    expect(fetch.calls).toBe(3);
  });

  it('stops after one unreachable fetch instead of repeating it', async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return fakeResponse(
        { error: { code: 400, message: 'FAILED_DOCUMENT_REQUEST: the host refused the connection' } },
        { status: 400 },
      );
    }) as unknown as typeof fetch;
    await expect(
      runReport({ url: 'https://example.com/', runs: 5, save: false, fetchImpl: impl, sleepImpl: noSleep, targets }),
    ).rejects.toBeInstanceOf(InsufficientRunsError);
    expect(calls).toBe(1);
  });
});
