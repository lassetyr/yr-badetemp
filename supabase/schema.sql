-- yr-badetemp Supabase schema. Run once in the Supabase SQL editor.

create table if not exists readings (
  location_id text not null,
  epoch       bigint not null,
  time        timestamptz not null,
  water       double precision not null,
  air         double precision,
  wind_speed  double precision,
  wind_gust   double precision,
  wind_dir    double precision,
  primary key (location_id, epoch)
);

-- Public read-only access for the static chart. Writes use the service_role
-- key, which bypasses RLS.
alter table readings enable row level security;

create policy "Public read access"
  on readings
  for select
  to anon
  using (true);

-- Latest 48h water-temperature projection, one row per location, REPLACED on
-- every poll (upsert on the location_id primary key). This is NOT append-only —
-- it deliberately differs from `readings`; only the newest projection is kept.
create table if not exists forecast (
  location_id  text primary key,
  generated_at timestamptz not null,
  payload      jsonb not null
);
-- payload shape (built by buildProjection in scripts/lib.js):
--   { horizonH, model: "relaxation"|"persistence", coeffs: {a,b,c}|null,
--     backtest: {mae6,mae12,mae24,mae48},
--     points: [ { epoch, water, lower, upper }, ... ] }

-- Public read-only access for the static chart (anon = publishable key). Writes
-- use the service_role key, which bypasses RLS.
alter table forecast enable row level security;

create policy "Public read access"
  on forecast
  for select
  to anon
  using (true);

-- Hourly snapshots of the projection, kept for calibration. APPEND-ONLY and
-- never read by the site. Each payload's points carry the RAW met.no forecast
-- air/wind next to our projected water, so one row records both what we
-- predicted and the weather input it came from -- enough to score a past
-- projection against what actually happened, and to separate our model's error
-- from met.no's. That is the measurement INFLATE currently cannot be tuned
-- against (see CLAUDE.md).
--
-- hour_epoch is generated_at floored to the hour and is part of the primary
-- key, so the first poll of each hour inserts and the remaining ~3 collide into
-- ON CONFLICT DO NOTHING no-ops. That is what throttles ~93 daily polls to 24
-- rows/day (~51 MB/year) with no state in the poller.
create table if not exists forecast_archive (
  location_id  text not null,
  hour_epoch   bigint not null,       -- generated_at floored to the hour
  generated_at timestamptz not null,  -- the actual generation time
  payload      jsonb not null,        -- same shape as forecast.payload
  primary key (location_id, hour_epoch)
);

-- Read access for calibration scripts via the publishable key (the site itself
-- never queries this table). Writes use the service_role key, which bypasses RLS.
alter table forecast_archive enable row level security;

create policy "Public read access"
  on forecast_archive
  for select
  to anon
  using (true);

