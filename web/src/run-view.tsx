'use client';

import { useEffect, useRef, useState } from 'react';
import { api, ApiError, startRun, type Job } from './api';
import { href } from './router';
import { columnsOf, formatElapsed, scoreBand, slotsFor, type Slot } from './run';

const POLL_MS = 1000;

const ERROR_HELP: Record<string, string> = {
  INSUFFICIENT_RUNS:
    'Fewer than 60% of the runs returned data. This is usually quota (429) or timeouts. If every run failed to load the page, check that it is reachable from the public internet.',
  INVALID_URL: 'PSI can only measure a public http or https page.',
};

/** One measurement as it happens: polls the job until it ends, then opens the saved report. */
export function RunView({ jobId, onFinished }: { jobId: string; onFinished: () => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [lost, setLost] = useState<ApiError | null>(null);
  // Set while polls fail: the run keeps going on the server, so keep asking.
  const [trouble, setTrouble] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const finishedRef = useRef(false);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    finishedRef.current = false;
    setJob(null);
    setLost(null);
    setTrouble(null);

    const poll = async () => {
      try {
        const next = await api<Job>(`/jobs/${encodeURIComponent(jobId)}`);
        if (!live) return;
        setJob(next);
        setTrouble(null);
        setNow(Date.now());
        if (next.status === 'done' || next.status === 'failed') {
          if (!finishedRef.current) {
            finishedRef.current = true;
            onFinished();
          }
          // A saved report opens by itself. Replacing this page in the history means Back
          // goes to where the run was started, not to a finished run that would open it again.
          if (next.status === 'done' && next.save !== false && next.result) {
            location.replace(href.report(next.result.reportId));
          }
          return;
        }
      } catch (error) {
        if (!live) return;
        if (error instanceof ApiError && error.status === 404) {
          setLost(error);
          return;
        }
        // A dropped request is not the end of the run: say so and keep polling.
        setTrouble(error instanceof Error ? error.message : String(error));
      }
      timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [jobId, onFinished]);

  if (lost) {
    return (
      <section className="page">
        <h1 className="page-title">This run is no longer tracked</h1>
        <p className="lede">
          The server keeps runs in memory, so a restart forgets them. If the run finished and was saved, open it from
          the report list.
        </p>
      </section>
    );
  }
  if (!job) {
    return (
      <section className="page" aria-busy="true">
        <p className="lede">{trouble ? `Cannot read the run yet: ${trouble} Retrying.` : 'Loading the run.'}</p>
      </section>
    );
  }

  const { request } = job;
  const slots = slotsFor(job.progress ?? [], request.runs, job.status);
  const finished = slots.filter((slot) => slot.state === 'done' || slot.state === 'fail').length;
  const started = Date.parse(job.startedAt ?? job.createdAt);
  const ended = job.finishedAt ? Date.parse(job.finishedAt) : now;
  const running = job.status === 'running' || job.status === 'queued';

  return (
    <section className="page">
      <h1 className="page-title run-title">{running ? 'Measuring' : job.status === 'done' ? 'Measured' : 'Measurement failed'}</h1>
      <p className="run-url-line">
        <span className="mono">{request.url}</span>
      </p>
      <p className="run-meta">
        {request.strategy === 'mobile' ? 'Mobile' : 'Desktop'}, {request.runs} run{request.runs === 1 ? '' : 's'},{' '}
        {request.stat}
        {job.save === false ? ', not saved' : ''}
      </p>

      <div className="run-grid" role="list" aria-label="Runs">
        {columnsOf(slots).map((column, index) => (
          <div className="run-column" key={index}>
            {column.map((slot) => (
              <RunSlot key={slot.n} slot={slot} />
            ))}
          </div>
        ))}
      </div>

      <p className="run-status" aria-live="polite">
        {finished} of {request.runs} runs finished, {formatElapsed(ended - started)} {running ? 'so far' : 'in total'}
      </p>
      {trouble && running && <p className="form-error">Lost contact with the server: {trouble} Retrying.</p>}

      {job.status === 'done' && job.result && job.save === false && <UnsavedResult job={job} />}
      {job.status === 'failed' && <RunFailure job={job} />}
    </section>
  );
}

function RunSlot({ slot }: { slot: Slot }) {
  if (slot.state === 'done') {
    return (
      <div className={`slot slot-${scoreBand(slot.score)}`} role="listitem">
        <span className="slot-n">{slot.n}</span>
        <span className="slot-value">{slot.score}%</span>
      </div>
    );
  }
  if (slot.state === 'fail') {
    return (
      <div className="slot slot-bad" role="listitem" title={slot.error}>
        <span className="slot-n">{slot.n}</span>
        <span className="slot-value">Failed</span>
      </div>
    );
  }
  return (
    <div className={`slot slot-${slot.state}`} role="listitem" aria-label={slot.state === 'active' ? `Run ${slot.n} in progress` : `Run ${slot.n} waiting`}>
      <span className="slot-n">{slot.n}</span>
      <span className="slot-value">{slot.state === 'active' ? <span className="spinner" aria-hidden="true" /> : ''}</span>
    </div>
  );
}

/** A run measured with saving off: there is no report to open, so its result is shown here. */
function UnsavedResult({ job }: { job: Job }) {
  const result = job.result!;
  const gaps = result.targets?.gaps ?? [];
  const failing = gaps.filter((gap) => !gap.meets).length;
  const score = Math.round(result.headline.score);
  return (
    <div className="panel run-result">
      <div className="run-score">
        <span className={`run-score-value text-${scoreBand(score)}`}>{score}</span>
        <span className="run-score-label">{job.request.stat} score</span>
      </div>
      <div className="run-result-body">
        <p>
          {result.runsSucceeded} of {result.runsRequested} runs succeeded.{' '}
          {gaps.length > 0 && `${failing} of ${gaps.length} targets failing.`}
        </p>
        <p className="muted">Not saved, so there is no report to open. This result is gone when the server restarts.</p>
      </div>
    </div>
  );
}

function RunFailure({ job }: { job: Job }) {
  const [error, setError] = useState<string | null>(null);
  const code = job.error?.code ?? 'ERROR';
  async function retry() {
    setError(null);
    try {
      const { jobId } = await startRun({ ...job.request, save: job.save !== false });
      location.hash = href.run(jobId);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    }
  }
  return (
    <div className="panel run-failure" role="alert">
      <p className="run-failure-message">{job.error?.message ?? 'The measurement failed.'}</p>
      {ERROR_HELP[code] && <p className="muted">{ERROR_HELP[code]}</p>}
      <button type="button" className="button" onClick={retry} title={`Uses ${job.request.runs} PSI calls from your quota`}>
        Try again
      </button>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
