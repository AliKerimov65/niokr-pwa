-- =============================================
-- Схема БД для PWA «НИОКР Команда» (Supabase)
-- Выполнить: Supabase Dashboard -> SQL Editor -> New query -> Run
-- =============================================

-- Сообщения чата
create table if not exists messages (
  id bigint generated always as identity primary key,
  channel text not null default 'Общий',
  author text not null,
  role text,
  body text not null default '',
  file_name text,
  file_url text,
  client_id text,
  created_at timestamptz not null default now()
);

-- Задачи исполнителей
create table if not exists tasks (
  id bigint generated always as identity primary key,
  title text not null,
  assignee text,
  deadline date,
  status text not null default 'Новая',
  author text,
  created_at timestamptz not null default now()
);

-- Объявления
create table if not exists announcements (
  id bigint generated always as identity primary key,
  body text not null,
  author text,
  created_at timestamptz not null default now()
);

-- Документы (метаданные; сами файлы — в Storage bucket «files»)
create table if not exists documents (
  id bigint generated always as identity primary key,
  name text not null,
  size text,
  url text not null,
  author text,
  created_at timestamptz not null default now()
);

-- Публичный доступ для демо (все участники с ссылкой). Для продакшена замените на авторизацию.
alter table messages enable row level security;
alter table tasks enable row level security;
alter table announcements enable row level security;
alter table documents enable row level security;

create policy "messages all" on messages for all to anon using (true) with check (true);
create policy "tasks all" on tasks for all to anon using (true) with check (true);
create policy "announcements all" on announcements for all to anon using (true) with check (true);
create policy "documents all" on documents for all to anon using (true) with check (true);

-- Включение Realtime
alter publication supabase_realtime add table messages;
alter publication supabase_realtime add table tasks;
alter publication supabase_realtime add table announcements;
alter publication supabase_realtime add table documents;

-- Storage: публичный bucket для файлов
insert into storage.buckets (id, name, public) values ('files', 'files', true)
on conflict (id) do nothing;

create policy "files all" on storage.objects for all to anon
using (bucket_id = 'files') with check (bucket_id = 'files');
