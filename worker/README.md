# Poll Worker (Cloudflare Cron Trigger) — draft

A Cloudflare Worker that runs the poll on a Cron Trigger. It is meant to replace
the GitHub Actions workflow, the cron-job.org job that dispatches it, and the PAT
that job needs. Supabase stays as the database; the Worker writes to it exactly
like `scripts/poll.js` does.

`index.js` is only an adapter. The poll is `scripts/poller.js`, the same code
the Actions workflow runs through `scripts/poll.js`, so both paths always behave
identically. Writes are idempotent (readings PK, hourly archive key, single
forecast row), so the Worker and the workflow can run side by side while you try
it out.

## CPU budget (the one thing to watch)

The Workers Free plan allows **10 ms of CPU per Cron Trigger invocation**. Time
spent waiting on `fetch` does not count, so only JSON parsing and the forecast
projection matter. Measured locally (Node/V8) on a full 30-day window of ~4300
readings:

| | warm | cold (fresh isolate) |
|---|---|---|
| projection before the backtest fix | ~69 ms | ~55 ms |
| projection now | ~6 ms | ~30 ms |
| JSON parsing (met.no + 5 history pages) | — | ~3 ms |

Warm runs fit; a cold isolate may not, and a cron that fires every 20 minutes
will often start cold. Local timings are only a guide, so measure the real thing:
after deploying, check **CPU time** per invocation in the dashboard (Workers &
Pages → yr-badetemp-poll → Observability) or with `npx wrangler tail`.

If it goes over, the cost is limited: readings are inserted *before* the
projection starts, so an invocation cut short still stores the water data and
only skips that poll's forecast refresh. The fixes are, in order of effort:
the Workers Paid plan (USD 5/month, 30 s CPU for crons), or making the
projection cheaper (e.g. recomputing the backtest band hourly instead of every
poll).

A poll makes 11 subrequests; the Free limit is 50 per invocation.

## Setup

Run from this directory (`worker/`). Wrangler is not a dependency of the repo;
`npx` fetches it.

```bash
npx wrangler login
npx wrangler secret put YR_API_KEY
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_KEY   # the sb_secret_... key
npx wrangler deploy
npx wrangler tail          # watch the next cron run's logs and CPU time
```

The schedule (`crons` in `wrangler.toml`) is UTC, every 20 minutes. The Worker
has no fetch handler and no public URL.

## Local test run

```bash
printf 'YR_API_KEY=...\nSUPABASE_URL=...\nSUPABASE_SERVICE_KEY=...\n' > .dev.vars   # gitignored
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*/20+*+*+*+*"
```

This writes to the real Supabase project, just like a manual `node scripts/poll.js`.

## Switching over

1. Deploy, and let the Worker run alongside the workflow for a few days.
2. Confirm in the logs that runs succeed and CPU time stays under 10 ms.
3. Disable the cron-job.org job and revoke its PAT. Keep `poll.yml` and
   `scripts/trigger.sh` as a manual fallback, or delete them.
