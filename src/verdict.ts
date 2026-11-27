/**
 * The PASS / FAIL word the CLI and the web UI both print. No Node-only
 * imports, so the web bundle can use it too.
 */
import type { Gap } from './types.js';

/**
 * The verdict word. FAIL when the score misses its target, or when more than
 * half the targets fail; otherwise PASS. A green PASS beside a missed score
 * read as a pass, so the score alone is enough to fail. "2 of 6 failing" with
 * the score in target is still a mostly healthy page with work to do.
 */
export function verdictWord(gaps: Array<Pick<Gap, 'metric' | 'meets'>>): 'PASS' | 'FAIL' {
  const failing = gaps.filter((gap) => !gap.meets);
  if (failing.some((gap) => gap.metric === 'score')) return 'FAIL';
  return failing.length > gaps.length / 2 ? 'FAIL' : 'PASS';
}
