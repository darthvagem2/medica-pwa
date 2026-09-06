create table if not exists push_devices (
  device_id text primary key,
  secret_hash text not null,
  timezone text not null default 'UTC',
  subscription jsonb not null,
  active boolean not null default true,
  quiet_enabled boolean not null default false,
  quiet_start text not null default '23:00',
  quiet_end text not null default '07:00',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists reminder_jobs (
  device_id text not null references push_devices(device_id) on delete cascade,
  occurrence_id text not null,
  medication_id text not null,
  medication_label text not null,
  scheduled_at timestamptz not null,
  deadline_at timestamptz,
  next_notify_at timestamptz not null,
  repeat_minutes integer not null check (repeat_minutes in (10,15,30,45,60)),
  phase text not null check (phase in ('main','deadline','repeat','done')),
  sound boolean not null default true,
  vibration boolean not null default true,
  required boolean not null default true,
  url text not null default '/',
  active boolean not null default true,
  last_sent_at timestamptz,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(device_id, occurrence_id)
);
create index if not exists reminder_jobs_due_idx on reminder_jobs(active,next_notify_at);
