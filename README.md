# yr-badetemp — Water Temperature Tracker

Records the water temperature at **Dulpen, Holmestrand** every 30 minutes from the
[yr.no](https://www.yr.no) water-temperatures API and shows the history in an
interactive chart. No server, no database — GitHub Actions polls, the repo
stores the data, GitHub Pages serves the chart.

## How it works

- `.github/workflows/poll.yml` runs every 30 minutes, executes `scripts/poll.js`,
  and commits a new line to `data/dulpen.ndjson` when the source reading is newer.
- `index.html` + `app.js` fetch that file and render it with ECharts.

## Local development

```bash
npm test                 # run unit tests (Node 20+, no dependencies)
node scripts/poll.js     # fetch one reading into data/dulpen.ndjson
python3 -m http.server 8000   # then open http://localhost:8000/
```

## One-time GitHub setup

1. Create a GitHub repo and push this project to the `main` branch.
2. **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main`,
   folder: `/ (root)` → Save. The site appears at
   `https://<user>.github.io/<repo>/`.
3. **Settings → Actions → General** → Workflow permissions →
   **Read and write permissions** → Save (lets the workflow push data commits).
4. **Actions** tab → run the **Poll water temperature** workflow once via
   *Run workflow* to confirm it appends and commits a reading.

## Configuration

- Tracked spot: `LOCATION_ID = "0-10238"` in `scripts/poll.js`.
- Poll cadence: the `cron` in `.github/workflows/poll.yml`.
