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
