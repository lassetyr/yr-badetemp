// Node entry point for the poll (GitHub Actions, the Raspberry Pi timer in pi/,
// or by hand). Reads the secrets from the environment and runs ./poller.js.
import { runPoll } from "./poller.js";

runPoll({
  yrApiKey: process.env.YR_API_KEY,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
