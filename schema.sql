-- =============================================
-- Полная схема БД для PWA «НИОКР Команда» v4 (команды, этапы, изоляция по team_id)
-- Для НОВОГО проекта. Для существующего используйте migration.sql
-- =============================================

create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner text not null,
  invite_code text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists members (
  id bigint generated always as identity primary key,
  name text not null unique,
  role text,
  created_at timestamptz not null default now()
);

create table if not exists team_members (
  id bigint generated always as identity primary key,
  team_id uuid not null references teams(id) on delete cascade,
  member text not null,
  is_owner boolean not null default false,
  created_at timestamptz not null default now(),
  unique (team_id, member)
);

create table if not exists messages (
  id bigint generated always as identity primary key,
  team_id uuid references teams(id) on delete cascade,
  channel text not null default 'Общий',
  author text not null,
  role text,
  body text not null default '',
  file_name text,
  file_url text,
  client_id text,
  created_at timestamptz not null default now()
);

create table if not exists tasks (
  id bigint generated always as identity primary key,
  team_id uuid references teams(id) on delete cascade,
  title text not null,
  assignee text,
  deadline date,
  status text not null default 'Новая',
  author text,
  created_at timestamptz not null default now()
);

create table if not exists announcements (
  id bigint generated always as identity primary key,
  team_id uuid references teams(id) on delete cascade,
  body text not null,
  author text,
  created_at timestamptz not null default now()
);

create table if not exists documents (
  id bigint generated always as identity primary key,
  team_id uuid references teams(id) on delete cascade,
  name text not null,
  size text,
  url text not null,
  author text,
  created_at timestamptz not null default now()
);

create table if not exists stages (
  id bigint generated always as identity primary key,
  team_id uuid not null references teams(id) on delete cascade,
  num int not null,
  title text not null,
  subs jsonb not null default '[]',
  status text not null default 'Не начат',
  responsible text,
  note text,
  deadline date,
  created_at timestamptz not null default now()
);

alter table teams enable row level security;
alter table members enable row level security;
alter table team_members enable row level security;
alter table messages enable row level security;
alter table tasks enable row level security;
alter table announcements enable row level security;
alter table documents enable row level security;
alter table stages enable row level security;

create policy "teams all" on teams for all to anon using (true) with check (true);
create policy "members all" on members for all to anon using (true) with check (true);
create policy "team_members all" on team_members for all to anon using (true) with check (true);
create policy "messages all" on messages for all to anon using (true) with check (true);
create policy "tasks all" on tasks for all to anon using (true) with check (true);
create policy "announcements all" on announcements for all to anon using (true) with check (true);
create policy "documents all" on documents for all to anon using (true) with check (true);
create policy "stages all" on stages for all to anon using (true) with check (true);

alter publication supabase_realtime add table teams;
alter publication supabase_realtime add table members;
alter publication supabase_realtime add table team_members;
alter publication supabase_realtime add table messages;
alter publication supabase_realtime add table tasks;
alter publication supabase_realtime add table announcements;
alter publication supabase_realtime add table documents;
alter publication supabase_realtime add table stages;

insert into storage.buckets (id, name, public) values ('files','files', true) on conflict (id) do nothing;
create policy if not exists "files all" on storage.objects for all to anon
using (bucket_id = 'files') with check (bucket_id = 'files');
