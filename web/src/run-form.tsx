'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError, startRun } from './api';
import { href } from './router';
import { DEFAULT_RUNS, isPrivateHost, MAX_RUNS, normalizeUrl, parseRuns, type Stat, type Strategy } from './run';

/**
 * The CLI's measure command as a form: page, mobile or desktop, runs (the PSI
 * calls this costs), and under Options the headline statistic and --no-save.
 */
export function RunForm() {
  const [url, setUrl] = useState('');
  const [strategy, setStrategy] = useState<Strategy>('mobile');
  const [runs, setRuns] = useState(String(DEFAULT_RUNS));
  const [stat, setStat] = useState<Stat>('median');
  const [save, setSave] = useState(true);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which input the error is about, so only that one is outlined.
  const [errorField, setErrorField] = useState<'url' | 'runs' | null>(null);
  // A private host PSI cannot reach: asked once per address before quota is spent.
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const ids = useId();

  // Close the options panel on Escape or a click outside it.
  useEffect(() => {
    if (!optionsOpen) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOptionsOpen(false);
    const onClick = (event: MouseEvent) => {
      if (!optionsRef.current?.contains(event.target as Node)) setOptionsOpen(false);
    };
    addEventListener('keydown', onKey);
    addEventListener('mousedown', onClick);
    return () => {
      removeEventListener('keydown', onKey);
      removeEventListener('mousedown', onClick);
    };
  }, [optionsOpen]);

  const runCount = parseRuns(runs).runs;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const page = normalizeUrl(url);
    const count = parseRuns(runs);
    const problem = page.error ?? count.error;
    if (problem || !page.url || !count.runs) {
      setError(problem ?? 'Check the form.');
      setErrorField(page.error ? 'url' : 'runs');
      return;
    }
    setError(null);
    setErrorField(null);
    if (isPrivateHost(page.url) && unreachable !== page.url) {
      setUnreachable(page.url);
      return;
    }
    setUnreachable(null);
    setBusy(true);
    try {
      const { jobId } = await startRun({ url: page.url, strategy, runs: count.runs, stat, save });
      setUrl(page.url);
      location.hash = href.run(jobId);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
      setErrorField(caught instanceof ApiError && caught.code === 'INVALID_URL' ? 'url' : null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="run-form" onSubmit={onSubmit} noValidate aria-label="Measure a page">
      <label className="visually-hidden" htmlFor={`${ids}-url`}>
        Page address
      </label>
      <input
        id={`${ids}-url`}
        className="input run-url"
        type="url"
        inputMode="url"
        placeholder="https://example.com/page"
        autoComplete="url"
        spellCheck={false}
        value={url}
        onChange={(event) => {
          setUrl(event.target.value);
          setUnreachable(null);
        }}
        aria-invalid={errorField === 'url'}
        aria-describedby={errorField === 'url' ? `${ids}-error` : undefined}
      />

      <div className="segmented" role="radiogroup" aria-label="Device">
        {(['mobile', 'desktop'] as const).map((value) => (
          <label key={value} className={`segment${strategy === value ? ' is-on' : ''}`}>
            <input
              type="radio"
              name={`${ids}-strategy`}
              value={value}
              checked={strategy === value}
              onChange={() => setStrategy(value)}
            />
            {value === 'mobile' ? 'Mobile' : 'Desktop'}
          </label>
        ))}
      </div>

      <label className="runs-field">
        <input
          className="input runs-input"
          type="number"
          min={1}
          max={MAX_RUNS}
          step={1}
          value={runs}
          onChange={(event) => setRuns(event.target.value)}
          aria-label={`Runs, 1 to ${MAX_RUNS}`}
          aria-invalid={errorField === 'runs'}
          aria-describedby={errorField === 'runs' ? `${ids}-error` : undefined}
        />
        <span className="runs-unit">runs</span>
      </label>

      <div className="options" ref={optionsRef}>
        <button
          type="button"
          className="button button-quiet"
          aria-expanded={optionsOpen}
          aria-controls={`${ids}-options`}
          onClick={() => setOptionsOpen((open) => !open)}
        >
          Options{stat !== 'median' || !save ? ' (changed)' : ''}
        </button>
        {optionsOpen && (
          <div className="options-panel" id={`${ids}-options`}>
            <label className="field">
              <span className="field-label">Headline number</span>
              <select className="input" value={stat} onChange={(event) => setStat(event.target.value as Stat)}>
                <option value="median">Median of the runs</option>
                <option value="mean">Mean of the runs</option>
                <option value="mode">Most common value</option>
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={save} onChange={(event) => setSave(event.target.checked)} />
              <span>
                Save the report
                <span className="check-hint">Unsaved results are lost when the server restarts.</span>
              </span>
            </label>
          </div>
        )}
      </div>

      <button
        type="submit"
        className="button button-primary"
        disabled={busy}
        title={runCount ? `Uses ${runCount} PSI call${runCount === 1 ? '' : 's'} from your quota` : undefined}
      >
        {busy ? 'Starting' : 'Measure'}
      </button>

      {error && (
        <p className="form-error" id={`${ids}-error`} role="alert">
          {error}
        </p>
      )}
      {unreachable && !error && (
        <div className="form-warning" role="alert">
          <p>
            PSI runs from Google&apos;s cloud and cannot reach <span className="mono">{new URL(unreachable).hostname}</span>.
            The runs would measure an error page and still use {runCount ?? 'your'} PSI calls.
          </p>
          <div className="form-warning-actions">
            <button type="submit" className="button">
              Measure anyway
            </button>
            <button type="button" className="button button-quiet" onClick={() => setUnreachable(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
