// Node entry point for the poll (GitHub Actions, or by hand). Reads the secrets
// from the environment and runs the shared poll in ./poller.js; the Cloudflare
// Worker in worker/index.js runs the very same function from its Cron Trigger.
import { runPoll } from "./poller.js";

runPoll({
  yrApiKey: process.env.YR_API_KEY,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
