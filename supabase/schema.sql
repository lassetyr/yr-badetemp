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
