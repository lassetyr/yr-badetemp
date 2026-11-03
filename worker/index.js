// Cloudflare Worker that runs the poll from a Cron Trigger — a replacement for
// the GitHub Actions workflow + cron-job.org + PAT chain. It is a thin adapter:
// the poll itself is scripts/poller.js, the same code scripts/poll.js runs in
// Actions, so the two paths cannot drift apart. Both write idempotently (the
// readings PK, the hourly archive key, the replace-on-write forecast row), so
// running them side by side during a trial is harmless.
//
// Secrets come from `wrangler secret put` (see worker/README.md), never from
// wrangler.toml. There is deliberately no fetch handler: the Worker answers no
// HTTP requests, and wrangler.toml keeps it off workers.dev.
import { runPoll } from "../scripts/poller.js";

export default {
  async scheduled(controller, env) {
    await runPoll({
      yrApiKey: env.YR_API_KEY,
      supabaseUrl: env.SUPABASE_URL,
      supabaseServiceKey: env.SUPABASE_SERVICE_KEY,
    });
  },
};
