# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A serverless water-temperature tracker for Dulpen, Holmestrand. There is no
backend: GitHub Actions polls the yr.no API, the repo *is* the database
(`data/dulpen.ndjson`), and GitHub Pages serves a static chart. Every data point
is a git commit.

## Commands

```bash
npm test                      # run all unit tests (node --test, Node 20+, zero deps)
node --test test/lib.test.js  # run a single test file
node scripts/poll.js          # fetch one reading and append to data/dulpen.ndjson
python3 -m http.server 8000   # serve the site locally → http://localhost:8000/
GITHUB_TOKEN=<pat> ./scripts/trigger.sh   # manually fire the poll workflow (expect HTTP 204)
```

There is no build step, bundler, or lint config. ECharts is loaded from a CDN in
`index.html`; the browser code uses native ES modules.

## Architecture

Two halves share pure helpers but never import each other:

- **Poller** (`scripts/poll.js` → `scripts/lib.js`): runs in CI/Node. `poll.js`
  does all I/O (fetch, file read/append); `lib.js` is pure (extract reading from
  yr.no GeoJSON, parse last stored line, decide append, serialize). Failures
  `return` rather than throw — the run exits 0 so a transient API blip just waits
  for the next scheduled poll.
- **Browser app** (`index.html` + `app.js` → `src/data.js`): fetches the ndjson
  file, filters by time range, renders with ECharts. `src/data.js` is pure
  (parse ndjson, filter by range).

`lib.js` and `src/data.js` are deliberately I/O-free so the tests can exercise
logic without network or DOM. When adding logic, put the pure part in those
files and keep side effects in `poll.js` / `app.js`.

### Append-only data invariant

`data/dulpen.ndjson` is one JSON reading per line, oldest first, append-only.
`shouldAppend` only appends when the fetched reading's `epoch` is **strictly
newer** than the last stored one, so re-runs are idempotent and the file never
gets duplicate or out-of-order lines. Preserve this — don't rewrite or sort the
file.

### Scheduling reality

GitHub's `schedule:` cron is best-effort and frequently drops sub-hourly runs,
so the cron in `poll.yml` is only a fallback. The reliable path is an external
scheduler (e.g. cron-job.org) hitting the `workflow_dispatch` REST endpoint —
that's what `scripts/trigger.sh` documents and performs. The cron minutes
(`7,27,47`) are intentionally offset off `:00/:20/:40` to dodge GitHub's most
congested scheduler slots.

## Conventions

- All user-facing time is rendered in `Europe/Oslo` regardless of the viewer's
  device timezone (see `osloParts` in `app.js`). UI labels are in Norwegian.
- The poll workflow rebases before pushing (`git pull --rebase`) because
  concurrent/overlapping runs can race on `main`; `concurrency.group: poll`
  serializes them.

## Config knobs

- Tracked spot: `LOCATION_ID = "0-10238"` and `API_URL` in `scripts/poll.js`.
- Browser refresh cadence: `REFRESH_MS` in `app.js` (auto-refetches without page
  reload; pauses while the tab is hidden).
- Poll cadence: the `cron` in `.github/workflows/poll.yml` and the external
  scheduler.

## Design docs

Specs and plans live in `docs/superpowers/specs/` and
`docs/superpowers/plans/` — check there for the intended behavior behind a
feature before changing it.
