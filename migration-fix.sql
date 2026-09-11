-- ДОРАБОТКА миграции v4 (запустить после ошибки на CREATE POLICY)

-- 1. Политики RLS (идемпотентно)
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

-- 2. Realtime для новых таблиц (идемпотентно)
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

-- 3. Бакет для файлов + политика Storage
insert into storage.buckets (id, name, public) values ('files','files', true) on conflict (id) do nothing;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='files all') then
    create policy "files all" on storage.objects for all to anon
    using (bucket_id='files') with check (bucket_id='files'); end if;
end $$;
