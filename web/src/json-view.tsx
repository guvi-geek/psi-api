'use client';

import { useMemo, useState } from 'react';
import type { AggregatedReport } from '../../src/types';
import { formatBytes } from '../../src/render';
import { CopyButton } from './copy-button';
import { jsonSections } from './requests';

/** The stored report.json, whole or one section at a time, to read, copy or download. */
export function JsonView({ report }: { report: AggregatedReport }) {
  const sections = useMemo(() => jsonSections(report), [report]);
  const [section, setSection] = useState('');
  const value = section ? (report as unknown as Record<string, unknown>)[section] : report;
  const text = useMemo(() => JSON.stringify(value, null, 2), [value]);

  function download() {
    const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${report.reportId}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="stack">
      <div className="filter-bar panel">
        <div className="filter-row">
          <label className="sort-field">
            <span className="filter-label">Show</span>
            <select className="input" value={section} onChange={(event) => setSection(event.target.value)}>
              <option value="">The whole report</option>
              {sections.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.key} ({formatBytes(entry.bytes)})
                </option>
              ))}
            </select>
          </label>
          <span className="filter-spacer" />
          <CopyButton text={`npm run --silent psi -- --reportId ${report.reportId} --json`} label="Copy CLI command" quiet />
          <button type="button" className="button" onClick={download}>
            Download report.json
          </button>
        </div>
      </div>
      <pre className="json-text" tabIndex={0} aria-label={section ? `JSON of ${section}` : 'JSON of the whole report'}>
        {text}
      </pre>
      <p className="note">
        This is report.json as saved in data/. The CLI&apos;s --json adds four computed keys: images, matchedInsights,
        validity and warnings. Their content is on the Overview and Findings tabs.
      </p>
    </div>
  );
}
