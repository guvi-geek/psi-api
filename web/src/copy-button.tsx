'use client';

import { useState } from 'react';

/**
 * Copies `text`. When the browser refuses the clipboard, shows the text
 * selected so it can be copied by hand, instead of failing silently.
 */
export function CopyButton({ text, label, quiet }: { text: string; label: string; quiet?: boolean }) {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
      setTimeout(() => setState('idle'), 1600);
    } catch {
      setState('manual');
    }
  }
  return (
    <span className="copy-wrap">
      <button type="button" className={`button${quiet ? ' button-quiet' : ''}`} onClick={copy} title={text}>
        {state === 'copied' ? 'Copied' : label}
      </button>
      {state === 'manual' && (
        <input
          className="input mono copy-manual"
          readOnly
          value={text}
          aria-label={`${label}: select and copy`}
          autoFocus
          onFocus={(event) => event.target.select()}
          onBlur={() => setState('idle')}
        />
      )}
    </span>
  );
}
