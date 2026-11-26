'use client';

import { useState } from 'react';
import { api, ApiError } from './api';
import { reanalyzeLines, reanalyzeSummary, type ReanalyzeRow } from './compare';
import { CopyButton } from './copy-button';
import { href } from './router';

/**
 * The CLI's --reanalyze, in two moves: first a preview that writes nothing
 * (--no-save), then, if anything changed, the save. Free either way: it
 * rebuilds from runs.json and never calls PSI. Without `reportId` it sweeps
 * every saved report.
 */
export function ReanalyzeBox({ reportId, onSaved }: { reportId?: string; onSaved: () => void }) {
  const [phase, setPhase] = useState<'idle' | 'previewing' | 'previewed' | 'saving' | 'saved'>('idle');
  const [rows, setRows] = useState<ReanalyzeRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const scope = reportId ? 'this report' : 'every saved report';

  async function run(save: boolean) {
    setError(null);
    setPhase(save ? 'saving' : 'previewing');
    try {
      const body = await api<{ reanalyzed: ReanalyzeRow[] }>('/reanalyze', {
        method: 'POST',
        body: JSON.stringify(reportId ? { reportId, save } : { save }),
      });
      setRows(body.reanalyzed);
      setPhase(save ? 'saved' : 'previewed');
      if (save) onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
      setPhase('idle');
    }
  }

  const summary = reanalyzeSummary(rows);
  const interesting = rows.filter((row) => row.delta?.changed || row.error);
  const cli = `npm run psi -- --reanalyze${reportId ? ` --reportId ${reportId}` : ''}`;

  return (
    <div className="reanalyze">
      <div className="reanalyze-head">
        <p className="reanalyze-intro">
          Rebuild {scope} from its saved runs with today&apos;s rules. Costs no quota. The saved runs are never
          changed, so a rebuild can always be redone.
        </p>
        <div className="reanalyze-actions">
          <button
            type="button"
            className="button"
            onClick={() => run(false)}
            disabled={phase === 'previewing' || phase === 'saving'}
          >
            {phase === 'previewing' ? 'Checking' : 'Check what would change'}
          </button>
          <CopyButton text={cli} label="Copy as CLI" quiet />
        </div>
      </div>

      {error && <p className="form-error">{error}</p>}

      {(phase === 'previewed' || phase === 'saving' || phase === 'saved') && (
        <div className="reanalyze-result" aria-live="polite">
          <p className="reanalyze-summary">
            {summary.total} report{summary.total === 1 ? '' : 's'} checked: {summary.changed} changed,{' '}
            {summary.recovered} cost figure{summary.recovered === 1 ? '' : 's'} recovered, {summary.phantoms} phantom zero
            {summary.phantoms === 1 ? '' : 'es'} corrected
            {summary.failed ? `, ${summary.failed} could not be rebuilt` : ''}.
          </p>

          {interesting.length === 0 ? (
            <p className="muted">No saved report changes its conclusion. Nothing to save.</p>
          ) : (
            <ul className="reanalyze-list">
              {interesting.map((row) => (
                <li key={row.reportId}>
                  <a className="mono" href={href.report(row.reportId)}>
                    {row.reportId}
                  </a>
                  {row.error ? (
                    <p className="text-bad">{row.error}</p>
                  ) : (
                    <ul className="alert-list">
                      {reanalyzeLines(row.delta!).map((line) => (
                        <li key={line.text} className={`text-${line.tone}`}>
                          {line.text}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}

          {phase === 'saved' ? (
            <p className="text-good">
              {summary.saved} report{summary.saved === 1 ? '' : 's'} rewritten. Saved runs were left untouched.
            </p>
          ) : (
            summary.changed > 0 && (
              <button type="button" className="button button-primary" onClick={() => run(true)} disabled={phase === 'saving'}>
                {phase === 'saving' ? 'Saving' : `Save the rebuilt report${summary.changed === 1 ? '' : 's'}`}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
