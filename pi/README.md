# Polling from a Raspberry Pi

Runs the poll (`scripts/poll.js`, the same code GitHub Actions and the Cloudflare
Worker run) every 20 minutes on a Raspberry Pi with a systemd timer. No CPU
limit, no Actions minutes, no external scheduler or PAT.

Tested target: Raspberry Pi 4B on Raspberry Pi OS. Raspberry Pi OS's own
`nodejs` package (Node 18) is enough; the test suite passes on 18.

Each poll stores the five most recent readings (~50 min of sensor data), so a
power or network outage shorter than ~40 minutes loses nothing; `Persistent=true`
also runs one catch-up poll right after the Pi comes back.

## Setup

Run on the Pi, as your normal user (not root).

```bash
sudo apt update && sudo apt install -y git nodejs
node --version                       # 18 or newer
git clone https://github.com/lassetyr/yr-badetemp.git ~/yr-badetemp
```

Secrets go in a file only your user can read:

```bash
mkdir -p ~/.config/yr-badetemp
nano ~/.config/yr-badetemp/env
```

```
YR_API_KEY=...
SUPABASE_URL=https://vlwnfuoxkvkxhrlebcxq.supabase.co
SUPABASE_SERVICE_KEY=sb_secret_...
```

```bash
chmod 600 ~/.config/yr-badetemp/env
```

Install and start the timer as a systemd *user* unit:

```bash
mkdir -p ~/.config/systemd/user
cp ~/yr-badetemp/pi/yr-badetemp-poll.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now yr-badetemp-poll.timer
sudo loginctl enable-linger "$USER"  # keep user timers running without a login session
```

Run one poll now to check the secrets:

```bash
systemctl --user start yr-badetemp-poll.service
journalctl --user-unit yr-badetemp-poll -n 20 --no-pager
```

(`--user-unit` rather than `journalctl --user`: Raspberry Pi OS keeps the journal
in memory, so there are no per-user journal files and `--user` finds nothing.)

Expect `Fetched 5 reading(s), inserted N new; ...` and `Projection updated: ...`.
A `401` means one of the keys is wrong.

## Day to day

```bash
systemctl --user list-timers yr-badetemp-poll.timer        # next and last run
journalctl --user-unit yr-badetemp-poll --since today     # logs
cd ~/yr-badetemp && git pull                               # pick up code changes (next run uses them)
```

After changing the unit files in this folder, copy them again and run
`systemctl --user daemon-reload`.

## Switching over

Once the Pi has run cleanly for a day or two:

1. Remove the Cloudflare Worker: `cd worker && npx wrangler delete`.
2. Disable the cron-job.org job and revoke its GitHub PAT.
3. Keep `.github/workflows/poll.yml` as a manual "Run workflow" fallback, or delete it.

Running more than one poller at once is harmless (every write is idempotent),
so there is no need to switch everything over at the same moment.
