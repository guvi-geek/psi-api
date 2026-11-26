/**
 * Re-analyze on a report measures the page again with that report's own
 * settings, saved as a new report. Spends `runs` PSI calls.
 */
export function rerunRequest(report: {
  url: string;
  strategy: 'mobile' | 'desktop';
  runsRequested: number;
  stat: 'median' | 'mean' | 'mode';
}): { url: string; strategy: 'mobile' | 'desktop'; runs: number; stat: 'median' | 'mean' | 'mode'; save: true } {
  return { url: report.url, strategy: report.strategy, runs: report.runsRequested, stat: report.stat, save: true };
}
