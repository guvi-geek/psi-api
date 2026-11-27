/**
 * Where reports live. The CLI keeps them as files under data/ (FileStore); the
 * web UI's server keeps them in MongoDB (MongoStore, src/db/mongo-store.ts) so
 * the team shares one history. Everything that measures or reads a report goes
 * through this interface, so both stores hold and return exactly the same data.
 */
import path from 'node:path';
import type { AggregatedReport, NormalizedReport, Strategy } from './types.js';
import type { ReportCategories } from './categories.js';
import {
  dataDirForHost,
  getDataDir,
  listReports,
  loadCategories,
  loadReport,
  loadRuns,
  saveCategories,
  saveReport,
} from './storage.js';

/** What the report list (sidebar, GET /reports) shows for one report. */
export interface ReportSummary {
  reportId: string;
  host: string;
  url: string;
  strategy: Strategy;
  stat: AggregatedReport['stat'];
  generatedAt: string;
  runsRequested: number;
  runsSucceeded: number;
  score: number;
  lcp: number | null;
  meetsTarget: boolean | null;
  targetsFailing: number;
  targetsTotal: number;
}

/** One page of the report list. With none of these, every report. */
export interface ListOptions {
  /** At most this many. */
  limit?: number;
  /** Only reports older than this id: the last id of the previous page. */
  before?: string;
  /** Only reports whose page address contains this, ignoring case. */
  q?: string;
}

/** The list filter both stores apply, so a page reads the same from files and MongoDB. */
export function matchesList(summary: Pick<ReportSummary, 'reportId' | 'url'>, options: ListOptions): boolean {
  if (options.before !== undefined && !(summary.reportId < options.before)) return false;
  if (options.q && !summary.url.toLowerCase().includes(options.q.toLowerCase())) return false;
  return true;
}

export interface ReportStore {
  /** Store a new report, its runs and nothing else. Returns where it went, for the log. */
  saveReport(report: AggregatedReport, runs: NormalizedReport[]): Promise<{ reportId: string; location: string }>;
  /** Rewrite a stored report (a reanalysis). Its runs are left as they are. */
  updateReport(report: AggregatedReport): Promise<void>;
  saveCategories(report: Pick<AggregatedReport, 'reportId' | 'url'>, categories: ReportCategories): Promise<void>;
  loadReport(reportId: string): Promise<AggregatedReport | null>;
  loadRuns(reportId: string): Promise<NormalizedReport[] | null>;
  /** Null for a report measured before runs read every category. */
  loadCategories(reportId: string): Promise<ReportCategories | null>;
  /** Stored reports, newest first: every one, or one page of them. */
  listSummaries(options?: ListOptions): Promise<ReportSummary[]>;
}

/** The host folder name data/ uses, so both stores group reports the same way. */
export function hostKey(url: string): string {
  return path.basename(dataDirForHost(url, '.'));
}

export function summarize(report: AggregatedReport, host = hostKey(report.url)): ReportSummary {
  const gaps = report.targets?.gaps ?? [];
  return {
    reportId: report.reportId,
    host,
    url: report.url,
    strategy: report.strategy,
    stat: report.stat,
    generatedAt: report.generatedAt,
    runsRequested: report.runsRequested,
    runsSucceeded: report.runsSucceeded,
    score: report.headline.score,
    lcp: report.headline.metrics.lcp ?? null,
    meetsTarget: report.targets?.meetsTarget ?? null,
    targetsFailing: gaps.filter((gap) => !gap.meets).length,
    targetsTotal: gaps.length,
  };
}

/** Reports as files under data/<host>/<reportId>/: the CLI's store. */
export class FileStore implements ReportStore {
  /** Without a folder, every call reads PSI_DATA_DIR (or data/) at that moment. */
  constructor(private readonly dataDir?: string) {}

  private dir(): string {
    return this.dataDir ?? getDataDir();
  }

  async saveReport(report: AggregatedReport, runs: NormalizedReport[]) {
    const saved = await saveReport(report, runs, this.dir());
    return { reportId: saved.reportId, location: saved.dir };
  }

  async updateReport(report: AggregatedReport): Promise<void> {
    const runs = await loadRuns(report.reportId, this.dir());
    if (!runs) throw new Error(`no stored runs for "${report.reportId}"`);
    await saveReport(report, runs, this.dir());
  }

  saveCategories(report: Pick<AggregatedReport, 'reportId' | 'url'>, categories: ReportCategories) {
    return saveCategories(report, categories, this.dir());
  }

  loadReport(reportId: string) {
    return loadReport(reportId, this.dir());
  }

  loadRuns(reportId: string) {
    return loadRuns(reportId, this.dir());
  }

  loadCategories(reportId: string) {
    return loadCategories(reportId, this.dir());
  }

  async listSummaries(options: ListOptions = {}): Promise<ReportSummary[]> {
    const summaries: ReportSummary[] = [];
    for (const ref of await listReports(this.dir())) {
      if (options.limit !== undefined && summaries.length >= options.limit) break;
      if (options.before !== undefined && !(ref.reportId < options.before)) continue;
      const report = await loadReport(ref.reportId, this.dir());
      if (!report) continue;
      const summary = summarize(report, ref.host);
      if (matchesList(summary, options)) summaries.push(summary);
    }
    return summaries;
  }
}
