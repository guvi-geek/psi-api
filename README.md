# psi-api

Measure a public page with the [Google PageSpeed Insights](https://developers.google.com/speed/docs/insights/v5/get-started) (PSI) API, from the terminal or from a web UI.

One PSI run is noisy. A report runs the page **10 times on mobile** by default, then shows the median, the range, and which targets the page misses. Desktop is the same command with `--desktop`; the number of runs is `--runs`. The same PSI calls also read the page's accessibility, best practices, SEO and agentic browsing, at no extra cost, and `--seo`, `--accessibility`, `--best-practices` or `--agentic` shows one of them instead of performance.

```bash
npm run psi -- <page>     # measure in the terminal
npm run ui                # or open the web UI at http://127.0.0.1:3939
```

The CLI, the web UI and the HTTP API share the same code. The CLI keeps its reports as files in `data/`; the web UI and the API keep theirs in MongoDB, so the team shares one history. Either way, re-reading a stored report later costs no quota.

> This folder is self-contained. It has its own `package.json` and its own git repo, and it does not depend on, or affect, the Qwik app in `../qwik-guvi`.

## Contents

1. [Setup](#setup): install, API key, environment
2. [Quick start](#quick-start): the commands you will use most
3. [Web UI](#web-ui)
4. [Measure a page](#measure-a-page): what a report looks like
5. [CLI](#cli): every option, [reading the output](#reading-the-output), [listing and comparing reports](#listing-and-comparing-reports), [`--reanalyze`](#--reanalyze-rebuilding-stored-reports-for-free), [SEO and more](#seo-and-more)
6. [Aggregation](#aggregation): how runs become one report, [first-party vs third party](#first-party-vs-third-party), [insights](#insights)
7. [Insight groups](#insight-groups)
8. [Targets](#targets): lab targets and real-user (CrUX) targets
9. [Storage](#storage)
10. [HTTP server and API](#http-server-and-api)
11. [Development](#development)
12. [Troubleshooting](#troubleshooting)
13. [Automation](#automation)

---

## Setup

```bash
cd psi-api
npm install
cp .env.example .env    # then paste your key, and MONGODB_URI for the web UI
npm test
npm run db:indexes      # once per database, before the web UI first uses it
```

### Getting a PSI API key

Without a key, PSI falls back to a shared anonymous quota that is **frequently already exhausted** — in practice you get `HTTP 429 Quota exceeded` before your first run finishes. Get a key:

1. Create a project in the [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **PageSpeed Insights API** for it.
3. Create an API key (APIs & Services → Credentials → Create credentials → API key).
4. Put it in `psi-api/.env`:

   ```
   PSI_API_KEY=AIza...
   ```

`.env` is gitignored. Never commit the key.

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PSI_API_KEY` | *(unset)* | Google PSI key. Optional but strongly recommended. |
| `PSI_CONCURRENCY` | `10` | Concurrent PSI calls per report (capped at 10). Quota is per run, not per concurrent call. Use `2` without an API key. |
| `PSI_FIRST_PARTY_HOSTS` | *(unset)* | Extra domains the measured site owns, comma-separated (`guvi.in,guvi.co`). Without this, a CDN on a sister host is filed as third-party. |
| `PSI_DATA_DIR` | `./data` | Where the CLI writes reports. |
| `MONGODB_URI` | *(unset)* | MongoDB for the web UI's reports. **Required by the server**, which does not start without it. The CLI never uses it. Use `127.0.0.1`, not `localhost`, through the cloudflared tunnel. |
| `PSI_MONGO_DB` | `PSI-API` | The server's database name. Tests use `PSI-API-test`. |
| `PORT` | `3939` | Port for the [server](#http-server-and-api): the web UI and the API. |
| `HOST` | `127.0.0.1` | Bind address for the server. |
| `LOG_LEVEL` | `info` | Pino log level for the server. |
| `PSI_API_URL` | `http://127.0.0.1:3939` | Where `npm run web:dev` forwards API calls. Only used by the web UI's dev server. |

---

## Quick start

Pass a public `http` or `https` page. Each measuring command spends one PSI call per run; reading saved results is free.

```bash
# Web UI: build it and serve it with the API at http://127.0.0.1:3939
npm run ui

# Performance, mobile, 10 runs (the default)
npm run psi -- https://example.com/

# Performance, desktop, 10 runs
npm run psi -- https://example.com/ --desktop

# Your own number of runs (1-40), mobile or desktop
npm run psi -- https://example.com/ --runs 5
npm run psi -- https://example.com/ --desktop --runs 15

# SEO and more: the same runs, showing one category instead of performance
npm run psi -- https://example.com/ --seo
npm run psi -- https://example.com/ --accessibility --runs 1
npm run psi -- https://example.com/ --best-practices --desktop
npm run psi -- https://example.com/ --agentic

# Read what you already measured - free, no PSI calls
npm run psi -- --list                                  # saved reports, newest first
npm run psi -- --cleanup                               # delete saved reports more than 3 days old
npm run psi -- --reportId <reportId>                   # one report again
npm run psi -- --reportId <reportId> --diagnose        # its ranked work queue
npm run psi -- --reportId <reportId> --seo             # its SEO (or --accessibility, ...)
```

| You want | Command | PSI calls |
| --- | --- | --- |
| The web UI | `npm run ui` | none until you measure |
| Mobile, 10 runs | `npm run psi -- <page>` | 10 |
| Desktop, 10 runs | `npm run psi -- <page> --desktop` | 10 |
| Mobile, N runs | `npm run psi -- <page> --runs <n>` | N |
| Desktop, N runs | `npm run psi -- <page> --desktop --runs <n>` | N |
| SEO, accessibility, best practices or agentic browsing | `npm run psi -- <page> --seo` (or `--accessibility`, `--best-practices`, `--agentic`) | same as the runs; `--runs 1` is enough |
| A category of a saved report | `npm run psi -- --reportId <id> --seo` | 0 |
| A saved report | `npm run psi -- --reportId <id>` | 0 |

---

## Web UI

```bash
npm run ui    # builds the UI, then serves it and the API at http://127.0.0.1:3939
```

A dark web UI for everything the CLI does. It is a static Next.js export in `web/`, served by the same server as the [HTTP API](#http-server-and-api), so nothing else has to run. `PORT` and `HOST` change the address.

The UI keeps its reports in **MongoDB** (`MONGODB_URI`), so the whole team shares one history. The CLI keeps its own reports as files in `data/`: a report measured in the terminal is not in the UI, and a report measured in the UI is not in `data/`. Before the server first uses a database, create its indexes once with `npm run db:indexes`.

- **Header bar.** Measure a page: address, Mobile or Desktop, number of runs, the headline number (median, mean or most common) and whether to save. Measuring opens a live view where each run lands as PSI returns it. The dot on the right says whether `PSI_API_KEY` is set.
- **Sidebar.** Saved reports, grouped by host, newest first, with a filter. Opening one costs no quota.
- **Home page.** The targets every report is graded against, including the [real-user targets](#targets) for INP and TTFB.
- **A report** has four tabs:
  - **Overview:** score, verdict and failing targets in one panel; every metric against its target with a bar and runs in target; real-user (CrUX) p75 values in the same order; how it was measured; every statistic side by side. **Re-analyze** measures the page again with the report's own settings, as a new report.
  - **Findings:** every Lighthouse finding with search, whose cost it is (anyone, ours, third party), hide flaky, and sort. Selecting one opens a drawer with its description, facts, per-run stats and rows, as `--items` prints them.
  - **Requests:** every request the median run made, summarised per type ("40 Images - 683KB"), filtered by party, request type, order and count.
  - **SEO and more:** accessibility, best practices, SEO and agentic browsing, read in the same PSI calls as the report, as four scores. Choosing one shows its audits: failed ones first with their details, then manual checks, passed and not applicable. No extra PSI call.

The UI never recomputes what the server or the CLI's own code works out, so it shows the same numbers the CLI prints.

For UI work, run the API and the Next.js dev server side by side:

```bash
npm run dev        # API (and the last built UI) on :3939, restarts on change
npm run web:dev    # UI with hot reload on :5190, API calls forwarded to PSI_API_URL
```

---

## Measure a page

The commands are in [Quick start](#quick-start). Each one prints a report a person can read.

`--runs` is how many PSI calls are aggregated into that one report. The default is **10**. The maximum is 40. Fewer runs finish sooner and are only a rough look. Ten is what you compare against a target, because one Lighthouse score moves by several points on a page that did not change.

`--desktop` measures the desktop form factor and the desktop budgets in `config/targets.json`. Leave it off and the command measures **mobile only**. `--strategy desktop` is the same as `--desktop`. `--mobile` forces mobile, which is already the default.

> `--silent` matters for anything machine-parsed. `npm run` writes its own `> psi-api@1.0.0 psi` banner to **stdout**, which breaks `npm run psi -- ... --json | jq`. Use `npm run --silent psi --` whenever the output is piped or parsed.

> The URL has to be reachable **from Google's public cloud**, not just from your machine. `https://www.guvi.co/` and `https://www.guin.com/` both currently return `FAILED_DOCUMENT_REQUEST` on every run for that reason, so neither is usable as a measurement target until it is publicly reachable.

A default mobile run, 10 PSI runs, looks like this:

```
PSI - API
mobile · 10 runs · https://www.guvi.in/zen-class/

 1. 92%     2. 91%     3. 93%     4. 92%     5. 95%
 6. 92%     7. 91%     8. 92%     9. 93%    10. 92%

https://www.guvi.in/zen-class/
mobile · Lighthouse 13.6.0 · median of 10/10 runs · 2026-11-26
measured under moto g power (2022) · CPU index 828 (higher = slower) · en-US · performance only

SCORE    92 / 100  target 90   range 91–95

VERDICT  PASS  1 of 6 targets failing
        LCP 3301ms vs 2500ms (0/10 runs in target)

  METRIC       MEDIAN  TARGET  VERDICT      % OF TARGET                    RUNS IN TARGET
  FCP          1351ms  1800ms  in target            75%  ██████··┃·······           10/10
  LCP          3301ms  2500ms  +801ms over         132%  ██████████×·····            0/10
  Speed index  2106ms  3400ms  in target            62%  █████···┃·······           10/10
  TBT            21ms   200ms  in target            11%  █·······┃·······           10/10
  CLS           0.004   0.100  in target             3%  ········┃·······           10/10

FINDINGS  32 shown
  EST. SAVING  INSIGHT                          AFFECTS  OURS   SEEN
        250ms  render-blocking-insight          LCP FCP  100%  10/10
        150ms  unused-css-rules                 LCP FCP  100%  10/10
         50ms  bootup-time                      TBT      100%  10/10
         50ms  long-tasks                       TBT      100%  10/10
         50ms  mainthread-work-breakdown        TBT         —  10/10
        115KB  unused-javascript                LCP FCP  100%  10/10
         10KB  legacy-javascript-insight        LCP FCP    0%  10/10
            —  cls-culprits-insight             CLS         —  10/10
  ...

  — in SAVING means Lighthouse gave no estimate, which is not zero.
  OURS is how much of the cost your own code is responsible for.

saved as reportId 2026-11-26T12-19-33Z-mobile
```

Every part of this is explained in [Reading the output](#reading-the-output). Filters, a ranked work queue, and re-reading a report you already paid for are in [CLI](#cli).

---

## CLI

The same command as [Measure a page](#measure-a-page). Nothing here starts the HTTP server.

```bash
npm run psi -- <page>                         # mobile, 10 runs
npm run psi -- <page> --desktop               # desktop, 10 runs
npm run psi -- <page> --runs <n>              # mobile, n runs
npm run psi -- <page> --desktop --runs <n>    # desktop, n runs
```

| Option | Default | |
| --- | --- | --- |
| `--desktop` | off | Desktop performance. Same as `--strategy desktop`. |
| `--mobile` | on | Mobile performance. This is the default, so you can leave the flag off. |
| `--runs <n>` | `10` | How many PSI runs go into this report. 1–40. |
| `--strategy <mobile\|desktop>` | `mobile` | Same choice as `--mobile` / `--desktop`. |
| `--reportId <id>` | — | Re-filter a **stored** report. Costs no quota and runs no PSI calls. |
| `--reanalyze` | off | Rebuild stored report(s) from their own retained runs with today's rules. Costs no quota. Combine with `--reportId`, or omit it to sweep everything in `data/`. |
| `--list` | off | List stored reports, newest first. Costs no quota. See [Listing and comparing reports](#listing-and-comparing-reports). |
| `--cleanup` | off | Delete every stored report more than 3 days old. `--dry-run` lists them without deleting. See [Storage](#storage). |
| `--compare <before> <after>` | — | `KEEP`, `REVERT` or `INCONCLUSIVE` for `--metric` (default: the baseline's worst failing metric), plus what changed in the requests. Costs no quota. |
| `--stat <mean\|median\|mode>` | `median` | Headline statistic. |
| `--group <list>` | — | `opportunity,diagnostic,passed,informative`. |
| `--minSavingsMs <n>` | — | |
| `--minSavingsBytes <n>` | — | |
| `--maxScore <n>` | — | e.g. `--maxScore 0.9`. |
| `--metric <list>` | — | `lcp,tbt,cls,fcp,speedIndex,tti,ttfb,inp`. |
| `--search <text>` | — | Matches audit id or title. |
| `--id <list>` | — | Exact ids. |
| `--hasItems` / `--noItems` | — | Require / forbid a details item list. |
| `--sortBy <savingsMs\|savingsBytes\|score\|firstPartyShare>` | `savingsMs` | |
| `--order <asc\|desc>` | `desc` | |
| `--party <any\|first\|third>` | `any` | Whose cost counts. See below. |
| `--minFirstPartyRatio <n>` | — | Keep only insights that are at least this fraction yours. |
| `--diagnose` | off | Print the ranked work queue, the LCP element, image checks, and the cautions. |
| `--items <list>` | — | Print every row of these insight ids (URLs, elements, snippets). |
| `--requests [start\|size]` | — | Print every request the median run made. Honours `--party` and `--limit`. |
| `--limit <n>` | — | |
| `--noFlaky` | — | Hide insights seen in <30% of runs. |
| `--json` | off | Machine-readable output, and a **superset** of the text view — see [What the text view does not show](#what-the-text-view-does-not-show). |
| `--no-save` | off | Don't write to `data/`. |
| `--seo` | off | Show the report's SEO instead of its performance. With a page it measures as usual; with `--reportId` it is free. See [SEO and more](#seo-and-more). |
| `--accessibility` | off | Show its accessibility instead. |
| `--best-practices` | off | Show its best practices instead. |
| `--agentic` | off | Show its agentic browsing instead. |
| `--seoId <id>` | — | Re-read an SEO check saved by an older version. Free. |
| `--seoList` | off | List those saved SEO checks, newest first. Free. |

```bash
npm run psi -- https://example.com
npm run psi -- https://example.com --desktop
npm run psi -- https://example.com --runs 3
npm run psi -- https://example.com --desktop --runs 15
npm run psi -- https://example.com --group opportunity --metric lcp --sortBy savingsMs --limit 5
npm run psi -- https://example.com --search "third-party" --json

# refine a report you already paid for - free, no PSI calls
npm run psi -- --reportId 2026-09-29T10-30-00Z-mobile --metric tbt --noFlaky

# the ranked work queue for a report you already paid for - also free
npm run psi -- --reportId 2026-09-29T10-30-00Z-mobile --diagnose --party first

# the rows of one insight, and the request table
npm run psi -- --reportId 2026-09-29T10-30-00Z-mobile --items image-delivery-insight
npm run psi -- --reportId 2026-09-29T10-30-00Z-mobile --requests size --limit 20

# upgrade stored reports written by older aggregation rules - free
npm run psi -- --reanalyze --no-save
```

Filters compose with `--reportId`, so narrowing a work queue after a 10-run baseline never costs another quota unit.

**Use `--diagnose --party first` when building a work queue.** `--diagnose` ranks findings by how they bear on the metrics that are actually failing, instead of leaving you to infer that from a flat savings sort.

### Reading the output

The default view, top to bottom. The sample in [Measure a page](#measure-a-page) shows each part.

**Progress** (stderr, only when PSI is actually run). A terminal shows a `PSI - API` title, then the runs as they finish. Before the first result, `1.` shows a spinner. The first run to finish replaces that with `1. 87%`, and `2.` starts spinning. Five runs share a line, and the sixth starts the next line. A failed run is `FAIL`. A cached attempt is not numbered; that run is numbered when an uncached result arrives. See [PSI caches per URL](#psi-caches-per-url).

**Header.** The measured URL (without the cache-busting nonce), then `strategy · Lighthouse version · <stat> of <succeeded>/<requested> runs · date`, then the [measured under](#the-measured-under-line) line.

**SCORE.** The headline score (the chosen `--stat`, median by default), its target, then the spread across runs as `range` (min–max). The score is green at 90+, yellow at 50–89 and red below 50, matching Lighthouse's own bands. When the score is [bimodal](#bimodality) a yellow line under it describes the two groups.

**VERDICT.** `N of M targets failing` counts every target in `config/targets.json` for the strategy — the score plus the five metrics in the table. A target fails when fewer than 90% of runs hold it, not only when the median misses (see [A budget is graded on the tail](#a-budget-is-graded-on-the-tail-not-the-median)). The word is `FAIL` only when **more than half** the targets fail, so `PASS  2 of 6 targets failing` is a mostly-healthy page that still has work to do; `meetsTarget` in the JSON is the strict all-targets verdict. The line under it names up to four failing targets, worst relative overshoot first, with how many runs held each. Two optional yellow lines can follow: one when every median is in target but the tail is not, and `not fixable from here: …` for a [budget the frontend cannot meet](#budgets-the-frontend-cannot-meet).

**Metric table.** One row per graded metric (FCP, LCP, Speed index, TBT, CLS). The score has no row; it is on the SCORE line.

| Column | Meaning |
| --- | --- |
| `METRIC` | Red when the median is over its target. |
| `MEDIAN` | The headline statistic for this metric (median unless `--stat` says otherwise). |
| `TARGET` | The budget from `config/targets.json`. |
| `VERDICT` | Where the median sits: `+Nms over` (red) or `in target` (green). Judged on the median only — the tail is the last column. |
| `% OF TARGET` | Median as a share of the budget. `100%` is exactly on it; red when over. |
| bar | The same share, drawn. The bar spans 0–200% of the target in 16 cells, so the marker sits in the same column on every row. `┃` is a target not reached, `×` is a target passed. The glyph carries the verdict without colour, for output pasted where ANSI is stripped. Values past 200% are clamped. |
| `RUNS IN TARGET` | How many individual runs held the budget. Green when the target passes (90%+ of runs); yellow when at least 70% of runs held it, or when the median is in target but too many runs missed; red otherwise. |

**FINDINGS.** Every normalized Lighthouse audit that survives the filters (all of them by default, including the metric audits such as `first-contentful-paint`, which carry no saving). `N shown` becomes `N of M shown` when filters or `--limit` hide some.

| Column | Meaning |
| --- | --- |
| `EST. SAVING` | Lighthouse's estimated saving in ms, or in bytes (`84KB`) when it gave only a byte figure. `—` means no estimate, which is [not the same as zero](#no-estimate-is-not-zero). |
| `INSIGHT` | The audit id. A yellow `(flaky)` suffix means it appeared in under 30% of runs. |
| `AFFECTS` | The metrics Lighthouse says the audit bears on. `—` when it names none. |
| `OURS` | The share of the cost on [first-party](#first-party-vs-third-party) hosts: green `100%`, yellow when mixed, dim `0%` when wholly third party, `—` when Lighthouse gave no URLs to attribute. |
| `SEEN` | Runs the audit appeared in, out of successful runs. |

Rows are sorted by `--sortBy` (default `savingsMs`, largest first). Ties and rows with no value for the sort field sort to the end in id order — so a finding priced only in bytes, like `unused-javascript` above, sits among the `—` rows under the default sort. Use `--sortBy savingsBytes` to rank those.

If any runs failed, a yellow `N run(s) failed:` block lists up to three of them. The last line is the `reportId` to pass to `--reportId` for free re-filtering.

`--diagnose` replaces FINDINGS with the ranked work queue, the LCP element, IMAGE CHECKS, and the cautions described under [`GET /report/:reportId/diagnosis`](#get-reportreportiddiagnosis); the metric table there shows only failing targets. `--items` and `--requests` print the rows of named insights and the median run's request table. Colour is on when stdout is a terminal; `NO_COLOR` turns it off and `FORCE_COLOR=1` forces it on.

### What the text view does not show

The default output is a summary. Several things in the report have **no representation in it at all**, and an agent comparing two measurements will reach for them:

| Only in `--json` / the API | Why it matters |
| --- | --- |
| `metrics.<metric>.min`, `.max`, `.values` | **The metric's own range and raw runs.** The SCORE line prints a range for the score alone; the metric table shows median, target, verdict, % of target, bar and runs-in-target. A change to LCP must be judged on `metrics.lcp`, and those numbers are JSON-only. |
| `distributions.<metric>` | Bimodality per metric. `--diagnose` raises a caution for the *score's* split only; `fcp`, `lcp`, `tbt`, `cls`, `speedIndex`, `tti` and `ttfb` are JSON-only. |
| `stats.mean` / `.median` / `.mode` | Every metric recomputed under each statistic, side by side. |
| `fieldData` | CrUX real-user data. See [field data](#field-data-crux) below. |
| `requests[]` in full | `--requests` prints a subset; the array carries `resourceSize`, `statusCode`, `priority`, `entity`, `mimeType`. |
| `insights[].title`, `.description` | Lighthouse's own prose for each audit. |
| `insights[].displayValue` | The raw human string savings were parsed out of — how you audit a suspicious estimate. |
| `insights[].itemHosts`, `.firstPartyItems`, `.thirdPartyItems` | The ownership evidence behind `firstPartyShare`, and what tells you "not actionable in repo". |
| `insights[].stats` | mean/median/mode of that insight's own score and savings, so you can see whether a saving is consistent across runs. |
| `insights[].items`, `.itemsTotal` | `--items` renders rows; `--json` gives them raw. |
| `environment` in full | Including `benchmarkIndex`, `hostUserAgent`, `channel`, `categories`. |
| `images.findings` | IMAGE CHECKS caps at 15 rows; this has every finding. |

`--json` also adds four keys the stored report does not have:

| Key | |
| --- | --- |
| `images` | The full image-check list, computed on demand. |
| `matchedInsights` | The insights **after** your filters. `insights` stays the complete unfiltered set, so read `matchedInsights` whenever you passed filters. |
| `diagnosis` | Present only alongside `--diagnose`. Same object [`GET /report/:reportId/diagnosis`](#get-reportreportiddiagnosis) returns. |
| `warnings` | Array of strings, including the [PSI cache](#psi-caches-per-url) warning. |

Two composition details worth knowing:

- **`--items` behaves differently under `--json`.** In text it prints the named insights' rows; in JSON the flag is converted into an `id` filter, so the matches — rows included — come back under `matchedInsights`.
- **`--requests` is a no-op under `--json`,** because `requests` is already in the payload.

```bash
# judge a change on the metric's own distribution, not the score's
npm run --silent psi -- --reportId $ID --json | jq '{
  lcp: (.metrics.lcp | {median, min, max, values}),
  bimodal: .distributions.lcp,
  field: .fieldData
}'
```

Without `jq` — and writing to a file rather than piping, because a reader that exits early kills the CLI with an unhandled `EPIPE`:

```bash
npm run --silent psi -- --reportId $ID --json > report.tmp.json
node -e '
const r = require("./report.tmp.json");
console.log(JSON.stringify({
  lcp: (({median, min, max, values}) => ({median, min, max, values}))(r.metrics.lcp),
  bimodal: r.distributions.lcp.bimodal,
  field: r.fieldData
}, null, 2));'
rm report.tmp.json
```

Keep that scratch file in the current directory: `require("/tmp/…")` works under a POSIX shell but fails on Windows, where Node resolves `/tmp` literally.

### Field data (CrUX)

Every report carries `fieldData`, passed through from PSI untouched. It is the only **real-user** data in the tool — everything else is a lab measurement on one emulated device:

```json
"fieldData": {
  "loadingExperience": { "initial_url": "https://example.com/", "metrics": { … }, "percentiles": { … } },
  "originLoadingExperience": { … }
}
```

`loadingExperience` is keyed on the exact measured URL, `originLoadingExperience` on the whole origin. **`{}` or `null` means insufficient traffic, not a bug** — CrUX needs a threshold of real sessions, so a staging host is essentially always empty. On staging, judge on the lab numbers and say so rather than reading the absence as a finding. The cache-busting [nonce](#the-cache-busting-param-never-appears-in-output) is stripped here too, so `initial_url` never carries `?psi_nonce=`.

It appears in `--json`, over HTTP, and in the web UI's **Real users** panel, which shows the p75 of FCP, LCP, INP, CLS and TTFB against their [targets](#targets). It is not rendered in the CLI's text output and is not part of `--diagnose`.

### `runs.json`: per-run detail

Every free command reads `report.json`, which is an **aggregate**. The individual runs sit beside it:

```
data/<host>/<reportId>/
  report.json   # the aggregate - what every CLI flag reads (the API returns the same JSON from MongoDB)
  runs.json     # one NormalizedReport per successful run
```

Only `--reanalyze` reads `runs.json`. It is the sole place to see `runs[].metrics` (the raw series behind the range), `runs[].requests[]` (each run's own request table — `report.json` keeps only the median run's), `runs[].insights[]`, `runs[].fetchTime`, and `runs[].environment`.

That last one is the reason to look. `report.environment` is taken from **the run closest to the median**, so it describes one run, not the set. On one real report stored by this tool, `report.environment.benchmarkIndex` read 473.5 while the ten runs behind it ranged from **105.5 to 1292.5** — a twelve-fold spread in the CPU each was scored against. Two runs under materially different conditions are not two samples of one population.

```bash
jq -r '.[] | "\(.environment.benchmarkIndex)\t\(.score)\t\(.fetchTime)"' data/<host>/<reportId>/runs.json

# same, without jq
node -e 'require(process.argv[1]).forEach(r =>
  console.log(r.environment.benchmarkIndex, r.score, r.fetchTime))' ./data/<host>/<reportId>/runs.json
```

Reading it is free and read-only. Do not edit it: `--reanalyze` rebuilds from it, and it is never rewritten, so a rebuild can always be redone.

### Listing and comparing reports

Report ids are `<ISO timestamp>-<strategy>-<6 hex>` (for example `2026-11-27T10-15-03Z-mobile-3fa9c1`) inside `data/<host>/`, so they sort chronologically; the random end keeps two reports of the same second apart. Ids from before it, without the end, still work everywhere. `--list` prints every stored report, newest first, at no quota cost (add `--json` for a machine-readable list). The server's `GET /reports` and the web UI's sidebar list the UI's own reports, from MongoDB.

```
$ npm run psi -- --list

REPORTS  20 stored, newest first
  2026-11-26T13-05-25Z-mobile  mobile  score 95.1  lcp 2836ms  https://www.guvi.in/
  2026-11-26T12-19-33Z-mobile  mobile  score 92  lcp 3301ms  https://www.guvi.in/zen-class/
  2026-11-26T11-10-18Z-mobile  mobile  score 93  lcp 3151ms  https://www.guvi.in/zen-class/
  2026-11-26T11-09-24Z-desktop  desktop  score 99  lcp 711ms  https://www.guvi.in/zen-class/
  ...
```

`--compare <before> <after>` says whether a change helped, judged on one metric's runs rather than the score: `KEEP`, `REVERT` or `INCONCLUSIVE`, with the reason, then what changed in the requests (document size, 404s, third parties). `--metric` picks the metric; without it, the baseline's worst failing metric is used. It costs no quota.

```
$ npm run psi -- --compare 2026-11-26T11-10-18Z-mobile 2026-11-26T12-19-33Z-mobile

COMPARE  lcp
  before 2026-11-26T11-10-18Z-mobile  range 2701ms–4051ms  pass 0%
  after  2026-11-26T12-19-33Z-mobile  range 2926ms–3376ms  pass 0%

VERDICT  INCONCLUSIVE
  lcp splits into two groups, so its range is not a noise band. Compare lane to lane before keeping
  a change.

REQUESTS
  document 85KB → 85KB
  404s resolved: none
  404s introduced: none
  third parties arrived: none
  third parties left: none
```

Compare two reports of the same page and device, taken with the same number of runs. The directories are a plain index too:

```bash
ls -1t data/<host>/                                    # newest first

# what a stored report actually is, without spending a command on it
jq -r '"\(.reportId)  \(.url)  score \(.headline.score)  lcp \(.headline.metrics.lcp)"' \
  data/<host>/<reportId>/report.json
```

`--reportId` and `GET /report/:reportId` search every host directory, so you need the id but not the host.

### `--reanalyze`: rebuilding stored reports for free

A stored `report.json` is a frozen snapshot of whatever the aggregation rules produced on the day it was written, so improving those rules does nothing for the history. `--reanalyze` re-derives each report from its own stored runs, which costs no PSI quota:

```
RE-ANALYZED 27 stored report(s), 25 with a changed conclusion, 68 cost figure(s) recovered, 373 phantom zero(es) corrected
  2026-09-30T03-50-24Z-mobile       changed (not saved)
      render-blocking-insight: was 0, actually 601ms (from items)
      16 finding(s) claimed 0ms where Lighthouse gave no estimate
  2026-09-30T03-53-46Z-mobile       changed (not saved)
      failing: [fcp lcp] -> [fcp lcp speedIndex tbt]
```

It reports two different corrections separately. A **recovered** figure is a real cost that a previous zero-rollup bug had been hiding. A **phantom zero** is a stored `0` that claimed an estimate of zero where Lighthouse gave none — corrected to `null`, and not counted as a win.

A rebuild only ever *fills in* a missing savings figure. A figure Lighthouse already supplied is never overwritten, because it may have come from a rollup that does not survive normalization and cannot be reconstructed — replacing a precise number with a row-derived approximation would be a downgrade. `runs.json` is left untouched so a rebuild can always be redone.

Exit code is `0` on success, `1` on error — so `npm run --silent psi -- <url> --runs 3 || echo "failed"` works in a script.

### SEO and more

Every run asks PSI for all of its categories in the same call: performance, accessibility, best practices, SEO and agentic browsing. **That costs no extra PSI calls.** The performance report is built exactly as before. Its scores, findings and `--json` don't change, and the "performance only" line still holds, because the report scores performance. The other four categories, from the report's median run (the same run its request table and environment come from), are saved beside it as `categories.json`.

One option per category shows it instead of performance:

| Option | Shows |
| --- | --- |
| `--seo` | SEO: whether search engines can crawl and index the page, and whether its title, description, links and images are written for them. |
| `--accessibility` | Accessibility: names and labels, contrast, ARIA, navigation, tables and lists, language. |
| `--best-practices` | Best practices: trust and safety, user experience, browser compatibility. |
| `--agentic` | Agentic browsing: whether an AI agent can read and use the page (accessibility tree, `llms.txt`, WebMCP). |

```bash
# measure as usual, then show one category instead of performance
npm run psi -- https://example.com --seo                      # 10 runs, mobile
npm run psi -- https://example.com --accessibility --runs 1   # one run is enough for these
npm run psi -- https://example.com --best-practices --desktop
npm run psi -- https://example.com --agentic --json           # the category as JSON

# read it from a report you already measured - free, no PSI calls
npm run psi -- --reportId <reportId> --seo
npm run psi -- --reportId <reportId> --accessibility --json
```

With a page, these measure exactly as the plain command does (`--runs`, `--desktop`, `--stat`, `--no-save` and `--json` all apply) and save the same report; only what is printed differs. One run is usually enough to read them, because these audits read the page's HTML, links, headers and `robots.txt`, which don't vary from run to run the way timings do. With `--reportId` they read the saved `categories.json` and cost nothing. A report measured before runs read every category has none, and says so.

A category of a real report:

```
BEST PRACTICES  https://www.guvi.in/zen-class/
mobile · Lighthouse 13.6.0 · 2026-11-27 03:54 UTC · 2026-11-27T03-55-12Z-mobile

SCORE    96 / 100   18 passed · 1 failed · 0 to check manually · 2 not applicable

USER EXPERIENCE  1 failed
  ✗ image-size-responsive    Serves images with low resolution
      node       URL                                      Displayed size  Actual size  Expected size
      GUVI Logo  https://www.guvi.in/assets/CekzYjB8-hc…  150 x 31        162 x 34     225 x 47

PASSED AUDITS  18
  ✓ is-on-https              Uses HTTPS
  ✓ geolocation-on-start     Avoids requesting the geolocation permission on page load
  ...
```

The sections follow the order the PSI website uses:

1. Audits that could not run, if any, marked `!` with their error.
2. Failed audits, `✗`, under their group (for example "Contrast" or "Crawling and Indexing"), each with its detail rows: the offending elements, links or lines.
3. "Additional items to manually check": audits Lighthouse can't decide, which you must check yourself. They have no pass/fail score.
4. "Passed audits".
5. "Not applicable".

Audits in Lighthouse's `hidden` group are left out, as the website leaves them out. `--json` returns `{ reportId, category, ...check }`: the score, every audit (`failed`, `passed`, `manual`, `notApplicable` or `error`) with its detail table, the groups and the counts. The web UI's **SEO and more** tab shows the same four categories, and [`GET /report/:reportId/categories`](#get-reportreportidcategories) returns them over HTTP.

**Older SEO checks.** Before every run read all categories, `--seo` made its own single PSI call and saved the result as `data/<host>/seo/<seoId>.json`. Those checks stay readable, for free:

```bash
npm run psi -- --seoList                                   # saved checks, newest first
npm run psi -- --seoId 2026-11-26T10-00-00Z-mobile-seo     # one of them again
```

Only the CLI reads them: the server's old `/seo` routes are gone.

---

## Aggregation

Every metric and the score are reported with all three statistics plus the raw values, so a caller can always see the shape of the distribution. **All of this is `--json` / API only** — the text view prints a spread line for the score and nothing per-metric (see [What the text view does not show](#what-the-text-view-does-not-show)):

```json
{
  "headline": { "score": 58, "metrics": { "lcp": 3210 } },
  "score": {
    "mean": 57.6, "median": 58, "mode": 58,
    "min": 52, "max": 61, "count": 10,
    "values": [55, 57, 58, 58, 59, 61, 52, 60, 58, 56]
  },
  "distributions": {
    "score": { "bimodal": true, "lanes": [ { "min": 52, "max": 58, "mean": 56.1, "count": 5 }, { "min": 59, "max": 61, "mean": 60, "count": 5 } ] },
    "lcp":   { "bimodal": false }
  },
  "stats": {
    "mean":   { "score": 57.6, "metrics": { "lcp": 3244 } },
    "median": { "score": 58,   "metrics": { "lcp": 3210 } },
    "mode":   { "score": 58,   "metrics": { "lcp": 3200 } }
  }
}
```

- **`median` is the default headline.** Lighthouse is skewed by occasional slow runs; the median is far more stable run to run and is what you should compare against when deciding whether a change helped.
- **`mean`** is pulled around by outliers. Useful when you specifically care about the average user cost.
- **`mode`** is the most frequently observed bucket. Read it as "what this page typically scores", not as a precise figure.
- **`min` / `max` are the observed range.** Together with `values` they are the only spread this tool reports; the width of the range is the noise band used by `--compare`.
- **`distributions.<metric>` reports bimodality.** If `bimodal` is `true`, the samples split into two genuinely different states and the median sits in one of them by run count, not because the page reliably performs there. See below.
- Runs execute with bounded concurrency (`PSI_CONCURRENCY`, default 10, so a 10-run report goes out in one round and takes about as long as its slowest run). The limit is per report: two reports running at once put twice as many calls in flight. Compare reports only against baselines taken at the same concurrency, since a burst of simultaneous loads can raise the origin's TTFB. Some runs may fail; the run continues and the result reports `runsRequested` vs `runsSucceeded`. **If fewer than 60% of runs succeed the whole call fails** with `INSUFFICIENT_RUNS` rather than reporting a misleading number.

#### Bimodality

A page whose score splits into two clusters has no single meaningful range — averaging the lanes produces a spread that describes neither. The tool splits the samples at the point that minimises within-lane spread (Otsu's method in 1D) and reports `bimodal: true` only when all three hold:

- both lanes hold at least **20%** of the samples,
- there are at least **6** samples in total,
- the lane means are far enough apart to be more than jitter (`separation` ≥ 4 — a uniform spread measures about 3.2, a real two-lane split about 8.0).

A single bad run among nine good ones is therefore reported as ordinary spread, not as a second mode. When `bimodal` is `true`, compare within a lane, and work out which lane your change moved before accepting it.

### The LCP element, not just the LCP number

An aggregated report carries `lcp`, read from the run closest to the median:

```json
"lcp": {
  "isText": true,
  "phases": { "ttfb": 578.17, "renderDelay": 1083.34 },
  "totalMs": 1662,
  "dominantPhase": "renderDelay",
  "bottleneck": "render"
}
```

Two facts decide which playbook applies, and neither is visible in the LCP number alone:

- **`isText`** — if the LCP element is a text node there is no image to prioritise, lazy-load or resize, so `lcp-discovery-insight`, `prioritize-lcp-image-insight` and `lcp-lazy-loaded-insight` do not apply. On a real deployment of this project the LCP element is a `<div>` of body copy, and `lcp-discovery-insight` is `notApplicable`. There is deliberately no load phase in that case, because there is no resource to load — the absence is the finding.
- **`bottleneck`** — `loadDelay`/`loadTime` means fetch earlier; `renderDelay` means something is blocking paint, usually CSS; `ttfb` means the server is the constraint and no component change will help.

### The "measured under" line

Every report header carries a line recording the conditions the run was taken under:

```
measured under moto g power (2022) · CPU index 928 (higher = slower) · en-US · performance only
```

PSI chooses the device, throttle and CPU server-side — the caller cannot request them — so the only way to know what a stored number means is to record what the response said about it. The line captures the device (parsed from the network user agent), the CPU benchmark index, locale and categories.

Two reports are only comparable when measured under the same conditions. A score that moves with the CPU index has not improved.

**This line describes one run, not the set.** `environment` is taken from the run whose score is closest to the median — the run the headline numbers describe — so the conditions of the other nine are not summarised anywhere in `report.json`. On one real report stored by this tool, `report.environment.benchmarkIndex` read 473.5 while the ten runs behind it ranged from **105.5 to 1292.5**. When you need every run's own conditions, read `runs.json` ([details](#runsjson-per-run-detail)).

Throttling is deliberately absent: PSI does not echo it, and inferring "Slow 4G" from the form factor would be a guess printed as a measurement.

Reports stored before this was recorded show `Lighthouse 13.5.0, device not recorded` or `not recorded`. They are still usable, but their conditions cannot be verified.

### PSI caches per URL

**The single most important thing to know about multi-run measurement.** PSI caches results per URL: asking for the same URL twice in a row returns *one* Lighthouse run, not two. Measured directly against the live API — five back-to-back calls returned one identical `analysisUTCTimestamp`.

Left alone, `runs=10` silently becomes *one* measurement counted ten times. Every value is identical and the range collapses to a single number, so the median is a single sample wearing ten hats. That defeats the entire reason this tool exists.

So every run requests a unique param on the target URL:

```
https://example.com/          <- the report records this
https://example.com/?psi_nonce=k3f9a2   <- what is actually requested
```

- `report.url` and the `data/<host>/` path stay clean; only the wire request carries the nonce.
- A single fixed nonce would not help — the cache is keyed on the whole URL, so the value has to differ per run.
- Pass `cacheBust: false` to `runPsiCall` to disable it, e.g. if a site rejects unknown query parameters.

**A repeated timestamp is not a run.** After each response the tool compares `lighthouseResult.fetchTime` with the runs already accepted. The same timestamp means PSI served a cached analysis, so that response is discarded and the slot is requested again, up to 3 times. A report contains only runs with distinct timestamps. If fewer than 60% of the requested runs come back uncached, the command fails with `INSUFFICIENT_RUNS` instead of publishing a median built from copies.

```
run 8/10  cached, retrying
run 8/10  score 86
```

#### A zero range is not always a bug

Two different things produce identical scores, and they mean opposite things:

| Cause | What you see | Meaning |
| --- | --- | --- |
| **PSI cache** | The same analysis timestamp comes back again | That response is discarded and retried. It is not a sample. |
| **A pinned page** | Identical scores, but metrics wobble slightly | Real. A page far inside the "good" band — or scoring 100 — legitimately scores the same every time. |

`https://example.com/` returns the same score in every run for a legitimate reason: it is so far above the thresholds that every run rounds to 100. Its LCP still moves (754 / 771 / 783 ms across three runs). **Check the metrics, not just the score, before concluding anything.**

### First-party vs third party

Sorting by savings alone will send you after other people's code. On a real deployment of this project the top actionable findings by estimated saving were **both `static.cloudflareinsights.com`** — Cloudflare's own analytics beacon on Cloudflare's own hosting. No amount of editing the app source fixes either one, and they outrank every genuine finding.

So every insight now carries ownership:

```json
{
  "id": "cache-insight",
  "savingsMs": 150,
  "firstPartyItems": 0,
  "thirdPartyItems": 1,
  "firstPartyShare": 0,
  "itemHosts": ["static.cloudflareinsights.com"]
}
```

`firstPartyShare` is `0`–`1`, or `null` when the cost could not be attributed to a host at all. It is the share of *items*, not of bytes — an item is the unit Lighthouse's own audits report in.

Hosts come from `items[].url` and nested `items[].subItems.items[].url`. A host is **first party** if it equals the measured domain, is a subdomain of it, or is listed in `PSI_FIRST_PARTY_HOSTS`. `media.example.com` counts as yours when you measured `www.example.com`; `static.guvi.in` counts as yours when `PSI_FIRST_PARTY_HOSTS=guvi.in`. Without that list, a CDN on a sister domain is filed as third-party cost.

Use it as a filter:

```bash
# the work queue: only what editing this repo could plausibly fix
npm run psi -- <url> --group opportunity,diagnostic --maxScore 0.9 --party first

# stricter: require at least half the cost to be yours
npm run psi -- <url> --minFirstPartyRatio 0.5 --sortBy firstPartyShare

# what the tag managers are costing you, kept out of the queue above
npm run psi -- <url> --party third
```

- `party=first` drops an insight only when **all** of its cost is somebody else's (`thirdPartyItems > 0 && firstPartyItems === 0`). It **keeps** insights whose cost could not be attributed to a URL at all — main-thread breakdowns, LCP phase breakdowns. Those are usually your own JavaScript, and hiding them would hide the largest category of real work.
- A **mixed** finding is kept, because you own part of the fix. The previous behaviour dropped any insight with a single foreign-host row, which discarded real cost: on a real deployment of this project `unused-css-rules` held 43,098 bytes of the site's own dead CSS — 94% of the finding — plus one gstatic reCAPTCHA stylesheet, and the entire finding vanished from the queue because of that one row.
- `party=third` is the inverse, for auditing third-party cost deliberately.
- `minFirstPartyRatio` is the explicit middle ground, for when a small first-party share is not enough to justify the work.

`third-parties-insight` lists every entity other than the measured host. A row is third party unless **every** resource in it sits on a domain the site owns (`PSI_FIRST_PARTY_HOSTS`). `--diagnose` still reports wholly-third-party findings so they can be logged as "not actionable in repo", but demotes them to the bottom of the queue. Rows on owned hosts are routed as image or script work.

For each resource under `subItems`, we attach:

- `resourceType` — `Script`, `Image`, `Stylesheet`, `Font`, etc., read from Lighthouse's own network request log.
- `node` — selector and snippet, **when Lighthouse already flagged that resource in an element-level audit** (render-blocking scripts, mis-sized images). If Lighthouse never recorded a selector, this field is absent and you must grep for the URL yourself.

The grep gate applies:

```bash
grep -rn "static.guvi.in" qwik-guvi/src/
```

returns the component that builds those URLs so you can trace where they are referenced and decide whether to lazy-load or replace.

### "No estimate" is not "zero"

`savingsMs` and `savingsBytes` are always present, and are `null` when Lighthouse gave no estimate. They used to be `0` or absent, interchangeably, which conflated two different facts:

- `0` — this audit says the gain is nothing.
- `null` — this audit does not say. Common for checklist-style insights.

The distinction matters when choosing what to work on. `lcp-discovery-insight` reports a real failure (`fetchpriority=high` missing) with no time estimate; reported as `0` it sorted to the bottom of every work queue, indistinguishable from a genuinely worthless audit. It now sorts last *as unknown*, and can be surfaced deliberately:

```bash
npm run psi -- <url> --group diagnostic --maxScore 0.9 --sortBy score --order asc
```

Byte savings are rounded to whole bytes, and `itemsTotal` is always reported — previously it only appeared when more than 25 items were trimmed, so the row count was unanswerable for every smaller insight.

### The cache-busting param never appears in output

Runs are cache-busted with a unique `?psi_nonce=…` (see below), and Lighthouse echoes the URL it was given back in several places — including `lighthouseResult.finalUrl`, item URLs, third-party iframe fragments, and CrUX `initial_url`. All of it is stripped before anything is reported, so a saved report never claims the site was loaded with a parameter it never saw in production.

### Mode bucketing rules

Continuous values have to be bucketed before "most frequent" means anything. Widths:

| Value | Bucket width |
| --- | --- |
| `score` | 1 point |
| `lcp`, `fcp`, `tbt`, `speedIndex`, `tti`, `ttfb`, `inp` | 100 ms |
| `cls` | 0.01 |
| `savingsMs` | 100 ms |
| `savingsBytes` | 1024 B |

The most frequent bucket wins. **If two or more buckets tie for most frequent, the median is used instead** — a tie means the distribution is flat, and the median describes it better than an arbitrary winner. `mode` returns the bucket value, not a re-measured statistic.

### Insights

Insights are merged across runs by audit id:

- `appearedInRuns` / `runsSucceeded` — how consistently it showed up.
- `flaky: true` — it appeared in **fewer than 30%** of successful runs. Deprioritize these; they are usually an intermittent third party, not a stable problem.
- `savingsMs` / `savingsBytes` / `score` — aggregated with the chosen `stat`.
- `stats` — all three statistics for each of those, so you can see whether savings are consistent.
- `items` — taken from the run whose score was closest to the median, because that is the run the headline number describes. Truncated to the top 25, with `itemsTotal` giving the original length.

The fields on an insight, and where each one is readable. **Everything here is `--json` / API only** except the five the FINDINGS table prints (`savingsMs`, `id`, `metricsAffected`, `firstPartyShare`, `appearedInRuns`):

| Field | | Use it for |
| --- | --- | --- |
| `id` | `string` | The audit id. Pass to `--id`, `--items`, `--search`. |
| `title` | `string` | Lighthouse's short name for the audit. |
| `description` | `string` | Lighthouse's own prose explaining the audit. Not printed anywhere in the text output. |
| `displayValue` | `string` | The human string the audit reported, e.g. `"Est savings of 57 KiB"`. How you audit a suspicious estimate — and sometimes the *only* place a figure exists, which is why it is a savings source. |
| `score` | `number \| null` | The audit's own score, aggregated. `null` when Lighthouse emitted no score (common for modern `-insight` audits). |
| `scoreDisplayMode` | `string` | Why the score is or is not meaningful: `binary`, `numeric`, `informative`, `notApplicable`, `manual`. |
| `group` | `InsightGroup` | `opportunity`, `diagnostic`, `passed`, `informative`, `notApplicable`. See [Insight groups](#insight-groups). |
| `savingsMs` / `savingsBytes` | `number \| null` | The estimate, in whichever unit Lighthouse gave. `null` is "no estimate", not zero. |
| `savingsSource` | `SavingsSource` | Which field the figure was read from: `overall`, `metricSavings`, `items`, `displayValue`, `none`. |
| `metricsAffected` | `string[]` | The metrics Lighthouse says the audit bears on. |
| `items` / `itemsTotal` | `unknown[]` / `number` | The audit's rows, and how many there were before the top-25 trim. `--items` renders these. |
| `firstPartyItems` / `thirdPartyItems` | `number` | How many rows sit on your hosts vs someone else's. The counts behind `firstPartyShare`. |
| `itemHosts` | `string[]` | The distinct hosts behind the rows, capped for readability. **This is what tells you a finding is not actionable in your repo.** |
| `firstPartyShare` | `number \| null` | 0–1, or `null` when unattributable. |
| `appearedInRuns` / `runsSucceeded` | `number` | How many runs the audit appeared in, out of successful runs. |
| `flaky` | `boolean` | Fewer than 30% of successful runs. |
| `stats` | `AggregatedInsightStats` | mean/median/mode of this insight's `score`, `savingsMs` and `savingsBytes` — so you can see whether a saving is consistent or a one-run artifact. |

### How savings are read

Lighthouse reports estimated savings in several shapes depending on version and audit, so each is read in turn and the **first non-zero** one wins:

| Field | Used for |
| --- | --- |
| `details.overallSavingsMs` | Millisecond savings — Lighthouse's own rollup, the most authoritative figure available. |
| `audit.metricSavings` | **Lighthouse 10.4+** drops `overallSavingsMs` and reports per-metric savings instead. The largest value is used. |
| `details.items[].wastedMs` | Summed. |
| `displayValue` ("Est savings of 1.2 s") | Parsed last. Requires the word "saving" *and* an explicit unit, so a string like "Main thread work: 1.1 s" cannot be mistaken for a saving. |
| `details.overallSavingsBytes` | Byte savings — Lighthouse's own rollup. |
| `details.items[].wastedBytes` | Summed. |
| `displayValue` | Parsed last, for bytes. |

The source actually used is reported as `savingsSource`: `overall`, `metricSavings`, `items`, `displayValue`, or `none`.

Two details here are deliberate and worth not undoing:

- **"First non-zero", not "largest".** A rounded display string must never inflate an exact structured figure. `unused-css-rules` reports `overallSavingsBytes: 58008` and a display string of "Est savings of 58 KiB"; taking the largest would report 59392. Order of *precision* is the rule, not order of magnitude.
- **Zero means "no estimate", not "no gain".** Lighthouse 13 writes `overallSavingsMs: 0` for audits that carry a real cost, and treating that `0` as an answer short-circuited the fallback chain before the per-row sum was ever reached. On a real deployment of this project the three largest findings all reported `0ms` because of it:

| insight | reported | actually | from |
| --- | --- | --- | --- |
| `render-blocking-insight` | `0ms` | 601 ms | `items` |
| `unused-javascript` | `0ms` | 206 KiB | `displayValue` |
| `image-delivery-insight` | `0ms` | 33 KiB | `displayValue` |

The highest `savingsMs` reported anywhere before the fix was 150 ms.

---

## Insight groups

Every Lighthouse audit is sorted into exactly one group. Precedence, in order:

| Group | Rule |
| --- | --- |
| `notApplicable` | Lighthouse scored the audit out of scope. Not selectable via the `group` filter. |
| `passed` | A real score of **0.9 or better**. |
| `informative` | Display mode says there is nothing to act on (`informative`, `manual`). |
| `opportunity` | Lighthouse typed the details as an opportunity (`details.type === "opportunity"`). |
| `diagnostic` | Everything else worth reporting. |

Two deliberate choices:

- **A passing audit is `passed` even if its details are typed as an opportunity.** If it scored 0.9 there is nothing left to win, and reporting it as an opportunity would send you after a non-issue.
- **Modern `-insight` audits (Lighthouse 10.4+) are `diagnostic`.** These are emitted with `scoreDisplayMode: "informative"` and a null score but carry real `metricSavings` and item lists. Filing them as merely informative would hide the most valuable findings from the `group=opportunity,diagnostic` filter that optimization work depends on.

The audit list is derived from the response itself — the performance category's `auditRefs` plus any `-insight` audit — so a new Lighthouse release is picked up without a code change. Audits in the `hidden` group are skipped, since Lighthouse itself does not surface them. Metrics are still read from hidden audits.

---

## Targets

`config/targets.json` holds the pass/fail thresholds, per strategy:

```json
{
  "mobile":  { "score": 90, "lcp": 2500, "tbt": 200, "cls": 0.1, "fcp": 1800, "speedIndex": 3400 },
  "desktop": { "score": 90, "lcp": 1800, "tbt": 150, "cls": 0.1, "fcp": 1200, "speedIndex": 2400 },
  "field":   { "inp": 200, "ttfb": 900 }
}
```

`field` holds targets for the real-user (CrUX) p75 only, for both devices. The web UI's **Real users** panel judges each CrUX value on its `field` target when there is one, else on the lab target for the same metric. They never grade a report: the verdict, `meetsTarget` and `gaps` read the `mobile` or `desktop` block alone, so INP (which the lab cannot measure) and real-user TTFB get a target without changing any lab result. `GET /targets` returns the whole file, `field` included.

Every aggregated report includes:

```json
"targets": {
  "strategy": "mobile",
  "targets": { "score": 90, "lcp": 2500, "...": 0 },
  "meetsTarget": false,
  "medianPass": true,
  "gaps": [
    {
      "metric": "tbt", "actual": 117.5, "target": 200, "delta": -82.5,
      "passRate": 0.8, "overBudgetRuns": 2, "runsMeasured": 10,
      "meets": false
    }
  ],
  "blockedBy": []
}
```

`score` is the one metric where higher is better; everything else is a budget where lower is better. `meetsTarget` is `false` if **any** target metric is missed **or could not be measured** — an incomplete run never reports success.

### A budget is graded on the tail, not the median

A budget describes real sessions, not the middle of a distribution. Each gap is therefore graded on **how often individual runs land inside it**, and a gap fails when fewer than 90% of runs do (`DEFAULT_MIN_PASS_RATE`).

This catches a real false-pass. In one report, per-run TBT was `110, 118, 270, 86, 118, 116, 423, 122, 107.5, 117` against a 200 ms budget. The median is 117.5, so a median-only check reports a comfortable pass — while 2 of 10 runs busted the budget at 270 ms and 423 ms, and those over-budget runs are exactly what users experience and what drags the score down. The gap reports `meets: false`, `passRate: 0.8`, and the report carries `medianPass: true` so both verdicts are visible.

The pass-rate fields are **omitted entirely** when there is no per-run series to grade, so a single-run report or a hand-built aggregate keeps the original median-only behaviour. Pass-rate fields are also optional on the `Gap` type for the same reason.

`medianPass` on the comparison answers "would this have passed on the median alone?", and `diagnosis.unreliable` names the metrics where the median and the tail disagree.

### Budgets the frontend cannot meet

`blockedBy` reports a budget that the server round trip alone already exceeds, so no component change can reach it. It applies **only** to elapsed-time metrics (`fcp`, `lcp`, `speedIndex`, `tti`) and **only** when the median is over budget:

- TBT, INP and CLS are not bounded by TTFB. TBT accumulates main-thread blocking time, INP measures interaction latency, and CLS is unitless — applying a millisecond floor to them concludes things about two unrelated quantities.
- A metric that clears its budget on the median and misses on a couple of runs is variance to stabilise, not a structural ceiling. Calling that unreachable would excuse skipping work that genuinely can be done.

`worstGap` names the failing metric with the largest overshoot **relative to its own budget**, so a 400 ms LCP miss on a 2500 ms budget outranks a 3-point score miss on a 90-point target.

---

## Storage

The CLI and the web UI keep separate reports. The CLI writes files, described here. The UI server writes to MongoDB, in the database `PSI-API` (`PSI_MONGO_DB`): `reports` (one document per report, with the list fields beside it), `runs` (one per run) and `categories` (one per report). Each holds the same JSON text the files hold, so a report reads the same from either. The server only inserts and updates: it never deletes. `npm run db:indexes` creates the unique `reportId` indexes; run it on purpose before first use, because the server never creates an index. At start the server checks that all three are there, and stops with a message naming the missing one rather than run without them.

CLI reports land in `data/<host>/<reportId>/`:

```
data/
  www.guvi.co/
    2026-09-29T10-30-00Z-mobile/
      report.json     # the aggregated report (the same JSON the API returns)
      runs.json       # every normalized run, for re-analysis
```

`<reportId>` is `<ISO timestamp>-<strategy>`, which sorts chronologically. `data/` and `.env` are gitignored.

A report measured since every run read all categories also has `categories.json` beside `report.json`: the median run's accessibility, best practices, SEO and agentic browsing ([SEO and more](#seo-and-more)). Nothing that reads `report.json` reads it.

SEO checks saved by the older, separate `--seo` are in a `seo/` folder of the same host directory:

```
data/
  www.guvi.co/
    seo/
      2026-11-26T10-00-00Z-mobile-seo.json
```

`report.json` is a snapshot of whatever the aggregation rules produced on the day it was written, so improving those rules does nothing for history. `runs.json` keeps the per-run detail — metrics, insights, items, display strings — which is what `--reanalyze` rebuilds from at no quota cost, and what nothing else reads (see [`runs.json`: per-run detail](#runsjson-per-run-detail)). A rebuild **only fills in** a missing savings figure: one that Lighthouse already supplied is never overwritten, because it may have come from a rollup that does not survive normalization and cannot be reconstructed. `runs.json` is never rewritten, so a rebuild can always be redone.

`npm run psi -- --cleanup` deletes every stored report more than 3 days old, by the time in its id: its whole folder, with `report.json`, `runs.json` and `categories.json`. It keeps host folders, `seo/` checks, `optimization-log.md` and any folder whose name is not a report id. Add `--dry-run` to list what would go without deleting, and `--json` for the list as JSON. It only touches files; the UI's MongoDB reports are never deleted.

A host directory may also hold an `optimization-log.md`, the append-only per-host record an optimizing agent maintains — see [AGENT_GUIDE.md](./AGENT_GUIDE.md) Step 10. The tool never creates or reads it.

The public `guvi-guvi` SOP sets the real bar: **Lighthouse 90+ minimum, 95+ best case, mobile and desktop.** The desktop thresholds above are the tighter interpretation of that; adjust both to match what you actually enforce.

---

## HTTP server and API

The server hosts the [web UI](#web-ui) at `/` and a JSON API for other programs. You do not need it to measure a page in the terminal.

```bash
npm run ui     # build the UI, then serve the UI and the API at http://127.0.0.1:3939
npm run dev    # serve the API (and the last built UI), restarting on code changes
```

All responses are JSON. Errors are always `{ "error": { "code", "message" } }` with a matching status code.

### `POST /report` (or `GET /report?...`)

Runs PSI and returns the aggregated report. **This costs `runs` quota units and takes a while** — for anything above ~3 runs, prefer `?async=true`. Each run also reads accessibility, best practices, SEO and agentic browsing, at no extra cost; they are saved beside the report and returned by [`GET /report/:reportId/categories`](#get-reportreportidcategories).

| Param | Default | Notes |
| --- | --- | --- |
| `url` | *required* | Must be public `http`/`https`. |
| `strategy` | `mobile` | `mobile` or `desktop`. |
| `runs` | `10` | 1–40. |
| `stat` | `median` | `mean`, `median` or `mode`. Headline statistic. |
| `force` | `false` | Skip the 10-minute cache. |
| `async` | `false` | Return `{ jobId }` immediately instead of waiting. See [`GET /jobs/:jobId`](#get-jobsjobid). |
| `save` | `true` | `false` does not store the report in MongoDB, like the CLI's `--no-save`. |

```bash
# single fast check
curl "http://127.0.0.1:3939/report?url=https://example.com&runs=3"

# full 10-run report, as JSON body
curl -X POST http://127.0.0.1:3939/report \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","runs":10,"stat":"median","strategy":"mobile"}'

# don't block on a long run
curl -X POST http://127.0.0.1:3939/report \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","runs":10,"async":true}'
# -> {"jobId":"job_m1a2b3_7","status":"queued"}

curl http://127.0.0.1:3939/jobs/job_m1a2b3_7
```

Responses for the same `url` + `strategy` + `runs` + `stat` are cached in memory for 10 minutes; a cache hit is returned with `"cached": true`. Use `force=true` to measure again immediately.

### `GET /report/:reportId`

Re-reads a report the server stored in MongoDB. No quota cost.

```bash
curl http://127.0.0.1:3939/report/2026-09-29T10-30-00Z-mobile
```

### `GET /report/:reportId/categories`

The report's other categories, read in the same PSI calls as its performance: `{ "reportId", "categories": { "accessibility", "best-practices", "seo", "agentic-browsing" } }`, each in the shape `--seo --json` prints. `categories` is `null` for a report measured before runs read them. No quota cost; `404` for an unknown report.

```bash
curl http://127.0.0.1:3939/report/$ID/categories
```

### `GET /report/:reportId/insights`

Filters a stored report. Every parameter is optional and they all combine.

| Param | Meaning |
| --- | --- |
| `group` | `opportunity`, `diagnostic`, `passed`, `informative`. Comma-separated. |
| `minSavingsMs` / `minSavingsBytes` | Minimum estimated saving. |
| `maxScore` | Only audits scoring at or below this, e.g. `0.9` for failing/weak. |
| `metric` | `lcp`, `tbt`, `cls`, `fcp`, `speedIndex`, `tti`, `ttfb`, `inp`. Comma-separated. |
| `search` | Case-insensitive substring of audit id or title. |
| `id` | Exact audit ids, comma-separated. |
| `hasItems` | `true` = only audits carrying a `details.items` list. |
| `sortBy` | `savingsMs` (default), `savingsBytes`, `score`, `firstPartyShare`. |
| `order` | `desc` (default) or `asc`. |
| `party` | `any` (default), `first`, `third`. See below. |
| `minFirstPartyRatio` | `0`–`1`. Keep only insights whose `firstPartyShare` is at least this. |
| `limit` | Max results. |
| `includeFlaky` | `true` (default). `false` hides insights seen in <30% of runs. |

```bash
# the LCP work queue
curl "http://127.0.0.1:3939/report/$ID/insights?group=opportunity,diagnostic&maxScore=0.9&metric=lcp&sortBy=savingsMs"

# everything that could save at least 100ms, cheapest first
curl "http://127.0.0.1:3939/report/$ID/insights?minSavingsMs=100&order=asc"

# mostly your own cost, ranked by how much of it is yours
curl "http://127.0.0.1:3939/report/$ID/insights?minFirstPartyRatio=0.5&sortBy=firstPartyShare"
```

The response carries the headline numbers and target verdict alongside the filtered list, so one call is usually enough:

```json
{
  "reportId": "2026-09-29T10-30-00Z-mobile",
  "headline": { "score": 58, "metrics": { "lcp": 3210, "tbt": 90 } },
  "targets": {
    "meetsTarget": false,
    "medianPass": true,
    "gaps": [ { "metric": "lcp", "actual": 3210, "target": 2500, "delta": 710, "passRate": 0.8, "overBudgetRuns": 2, "runsMeasured": 10, "meets": false } ],
    "blockedBy": []
  },
  "lcp": { "isText": true, "phases": {}, "bottleneck": "render" },
  "distributions": { "score": { "bimodal": false } },
  "totalInsights": 19,
  "matched": 3,
  "insights": [ /* ... */ ]
}
```

### `GET /report/:reportId/diagnosis`

The ranked work queue. Where `/insights` answers "what did Lighthouse find", this answers "what should I work on": it orders findings by how they bear on the metrics that are actually failing, attaches the playbook route for each, and reports the things that would otherwise be over-read.

```bash
curl "http://127.0.0.1:3939/report/$ID/diagnosis?party=first"
```

| Field | |
| --- | --- |
| `priorityOrder` | Failing gaps, worst relative overshoot first. |
| `primary` | The single metric to work on. |
| `ranked` | The queue: each finding with its `sop` route, `affectsFailing`, `firstPartyShare`, `thirdPartyOnly` and a plain-English `reason`. |
| `unreliable` | Metrics whose median is inside budget but whose runs are not — the false-PASS case. |
| `blocked` | Budgets the server round trip makes unreachable. |
| `cautions` | Everything that changes how the numbers should be read. |
| `exhausted` | `true` when the failing metrics have no first-party work left against them. Stop and escalate. |
| `images` | The full image-check list. The CLI's IMAGE CHECKS block caps at 15 rows; this is every finding. |

The response also carries `reportId`, `url`, `strategy`, `headline`, `targets`, `lcp` and `distributions`.

`npm run psi -- --reportId <id> --diagnose` renders the same queue as text, through the same code path — but the CLI's IMAGE CHECKS block prints at most 15 rows, so read this endpoint (or `--json`) for the full list.

### `POST /insights`

One call that runs (or reuses) a report and applies filters to it — the HTTP equivalent of the CLI.

```bash
curl -X POST http://127.0.0.1:3939/insights \
  -H 'content-type: application/json' \
  -d '{
        "url": "https://example.com",
        "runs": 10,
        "stat": "median",
        "strategy": "mobile",
        "filters": { "group": ["opportunity", "diagnostic"], "maxScore": 0.9, "sortBy": "savingsMs", "limit": 5 }
      }'
```

### `GET /jobs/:jobId`

The state of an `async=true` report: `queued`, `running`, `done` or `failed`. While it runs, `progress` has one entry per finished PSI attempt (`run`, `ok`, `score`, or `error`, and `cached` for a repeated analysis that is retried), which is what the web UI draws live. When it is `done`, `result` is the report; when it is `failed`, `error` says why. Jobs are kept in memory, so a restart forgets them.

```bash
curl http://127.0.0.1:3939/jobs/job_m1a2b3_7
# {"id":"job_m1a2b3_7","status":"running","progress":[{"run":1,"ok":true,"score":92}],"save":true, ...}
```

### `GET /reports`

The reports the UI has stored in MongoDB, newest first, a page at a time, as `{ "reports": [...], "next" }`: the same entries as the CLI's `--list`. Each has `reportId`, `host`, `url`, `strategy`, `stat`, `generatedAt`, `runsRequested`, `runsSucceeded`, `score`, `lcp`, `meetsTarget`, `targetsFailing` and `targetsTotal`. No quota cost.

| Param | Default | |
| --- | --- | --- |
| `limit` | `50` | Reports in this page, 1–200. |
| `before` | — | The previous answer's `next`: the page after it. |
| `q` | — | Only pages whose address contains this, ignoring case. |

`next` is `null` on the last page. The web UI's sidebar loads 50, with **Load more** for the next page, and its filter asks with `q`.

```bash
curl "http://127.0.0.1:3939/reports?limit=50"
curl "http://127.0.0.1:3939/reports?limit=50&before=2026-11-27T10-15-03Z-mobile-3fa9c1"
curl "http://127.0.0.1:3939/reports?q=zen-class"
```

### `POST /reanalyze`

The CLI's `--reanalyze` for the UI's reports: rebuilds them from their own stored runs with today's rules. No quota cost. Send `{ "reportId": "..." }` for one report, and `"save": false` to preview without writing. The answer is `{ "reanalyzed": [ { "reportId", "delta", "saved" } ] }`, where `delta` lists the recovered costs, corrected zeroes and changed failing metrics. It rewrites stored reports (never their runs), so it takes only a JSON body (`415` otherwise).

Rebuilding every report rewrites the team's whole history, so it has to be asked for: without a `reportId`, send `"all": true`, or the answer is `400`. It goes newest first, at most 50 reports a request (`"limit"`, 1–50), and the answer adds `next`: send it back as `"before"` for the following batch, until `next` is `null`.

```bash
curl -X POST http://127.0.0.1:3939/reanalyze \
  -H 'content-type: application/json' \
  -d '{"reportId":"2026-11-27T04-56-37Z-mobile","save":false}'

# every report, a batch at a time
curl -X POST http://127.0.0.1:3939/reanalyze -H 'content-type: application/json' -d '{"all":true,"save":false}'
# -> {"reanalyzed":[...],"next":"2026-11-20T08-15-00Z-mobile-3fa9c1"}
curl -X POST http://127.0.0.1:3939/reanalyze -H 'content-type: application/json' \
  -d '{"all":true,"save":false,"before":"2026-11-20T08-15-00Z-mobile-3fa9c1"}'
```

### `GET /targets`

The contents of `config/targets.json`: the lab targets per device and the real-user `field` targets. Read-only.

```bash
curl http://127.0.0.1:3939/targets
# {"mobile":{"score":90,"lcp":2500,...},"desktop":{...},"field":{"inp":200,"ttfb":900}}
```

### `GET /health`

```bash
curl http://127.0.0.1:3939/health
# {"status":"ok","uptimeSeconds":42,"apiKeyConfigured":true,"cacheEntries":0,"activeJobs":0}
```

---

## Development

```bash
npm test                # unit tests, no network
npm run typecheck       # tsc over src and tests
npm run dev             # API server in watch mode
npm run build           # emit dist/

npm run ui              # build the web UI, then serve it with the API
npm run web:dev         # web UI dev server with hot reload, on :5190
npm run web:build       # build the web UI into web/out
npm run web:typecheck   # tsc over the web UI
```

The code is in three places:

| Folder | What |
| --- | --- |
| `src/` | The CLI (`cli.ts`), the server (`server.ts`) and everything they share: PSI calls, aggregation, targets, rendering, storage, the categories (SEO and more). |
| `web/` | The Next.js web UI. `web/src/` holds its views and the small helpers that turn API answers into what the page shows; it imports the CLI's own formatting from `src/` rather than redoing it. |
| `tests/` | Vitest tests for both, including tests that the page and the CLI agree. |

Tests use saved PSI fixtures in `tests/fixtures/` (performance only, SEO only, and every category) and a mocked `fetch`; **no test calls PSI.** The one exception to staying offline is `tests/mongo-store.test.ts`, which runs against the dev MongoDB (in the `PSI-API-test` database) when `MONGODB_URI` is set and is skipped otherwise. Retry and backoff behaviour is verified by injecting the fetch, sleep and random functions.

To regenerate the fixture: `node scripts/make-fixture.js`.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `429 Quota exceeded` on every run | No API key, or the key's daily quota is spent. | Set `PSI_API_KEY`. |
| `INSUFFICIENT_RUNS` | Fewer than 60% of runs returned data. | Check the `errors` array; usually quota or timeouts. |
| `FAILED_DOCUMENT_REQUEST` on **every** run | Lighthouse loads the page from Google's public cloud and could not reach it — the host is down, blocking Google, or not publicly reachable. | Open the URL in a browser, then check it resolves publicly. A URL that works locally can still fail here. This is not a tool bug and retrying will not help. |
| Score `0` with a tiny `fetchTime` | The URL is `localhost`/private, so Lighthouse measured an error page. | Measure a deployed public URL. The tool warns about this up front. |
| Report takes minutes | Each run is a real PSI call, and a report waits for its slowest run. | Check `PSI_CONCURRENCY` is not set low in `.env`. Use `?async=true`, or `runs=3` while iterating. |
| Every insight shows `-` savings | Unexpected for Lighthouse 10.4+; those versions report `metricSavings`. | Should not happen — `metricSavings` is read as a fallback. If it does, the response shape has changed and the tool needs a look. |
| A single score value, every run identical | The page is pinned well inside the "good" band. A cached copy is no longer kept in the report. | Check the metric values for the real spread. If PSI keeps returning the same analysis, the command fails with `INSUFFICIENT_RUNS` and `PSI served a cached report`. |
| Site breaks when a query string is added | Cache busting appends `?psi_nonce=…` to the measured URL. | Rare, but real for strict routers. Use `cacheBust: false` in library code, or confirm the site is measured correctly. |

## Automation

See **[AGENT_GUIDE.md](./AGENT_GUIDE.md)** for how an autonomous agent should use this tool to drive a page to target in a measured, reversible loop.

That loop requires a staging deploy per change, and the deploy rules matter as much as the measuring:

- Open a **staging PR for the page** being optimized, wait a flat 10 minutes, then poll that PR once a minute until the build reaches a terminal conclusion.
- **Never push to a branch while its staging build is running.** The staging server is shared — a mid-build push cancels the in-flight build and can leave the site serving a half-applied deploy, breaking it for everyone. Freeze the branch until the run concludes; a *failed* build is terminal, so pushing a fix after one is fine.
- Confirm the new build hash is actually being served before measuring. A measurement against a stale edge is a false negative, and it will make you revert a change that worked.
