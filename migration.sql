-- =============================================
-- МИГРАЦИЯ v4: команды / участники / этапы + изоляция по team_id
-- SQL Editor: https://supabase.com/dashboard/project/lxgipzdybigdpdcmcnez/sql/new
-- =============================================

-- 1. Справочник участников
create table if not exists members (
  id bigint generated always as identity primary key,
  name text not null unique,
  role text,
  created_at timestamptz not null default now()
);

-- 2. Команды/проекты (автономные, видимы только участникам)
create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner text not null,
  invite_code text not null unique,
  created_at timestamptz not null default now()
);

-- 3. Состав команд
create table if not exists team_members (
  id bigint generated always as identity primary key,
  team_id uuid not null references teams(id) on delete cascade,
  member text not null,
  is_owner boolean not null default false,
  created_at timestamptz not null default now(),
  unique (team_id, member)
);

-- 4. Этапы календарного плана
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

-- 5. Привязка существующих таблиц к командам
alter table messages add column if not exists team_id uuid references teams(id) on delete cascade;
alter table tasks add column if not exists team_id uuid references teams(id) on delete cascade;
alter table announcements add column if not exists team_id uuid references teams(id) on delete cascade;
alter table documents add column if not exists team_id uuid references teams(id) on delete cascade;

-- 6. RLS (демо-режим: доступ по ссылке; для продакшена — Supabase Auth)
alter table members enable row level security;
alter table teams enable row level security;
alter table team_members enable row level security;
alter table stages enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='members' and policyname='members all') then
    create policy "members all" on members for all to anon using (true) with check (true); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='teams' and policyname='teams all') then
    create policy "teams all" on teams for all to anon using (true) with check (true); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='team_members' and policyname='team_members all') then
    create policy "team_members all" on team_members for all to anon using (true) with check (true); end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='stages' and policyname='stages all') then
    create policy "stages all" on stages for all to anon using (true) with check (true); end if;
end $$;

-- 7. Realtime для новых таблиц
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='members') then
    alter publication supabase_realtime add table members; end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='teams') then
    alter publication supabase_realtime add table teams; end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='team_members') then
    alter publication supabase_realtime add table team_members; end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='stages') then
    alter publication supabase_realtime add table stages; end if;
end $$;

-- 8. Storage-бакет для файлов
insert into storage.buckets (id, name, public) values ('files','files', true) on conflict (id) do nothing;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='files all') then
    create policy "files all" on storage.objects for all to anon
    using (bucket_id='files') with check (bucket_id='files'); end if;
end $$;
