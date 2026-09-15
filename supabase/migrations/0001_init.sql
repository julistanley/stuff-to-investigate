-- =============================================================================
-- Stuff to Investigate — initial schema
--
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste ->
-- Run. It is safe to read top to bottom; every section is commented.
--
-- Design summary
--   profiles      one row per login; role (admin/editor) + status (pending/
--                 approved/rejected). Created automatically on signup.
--   app_settings  key/value JSON. Holds the bootstrap admin email list.
--   nodes         the map. parent_id + position express the hierarchy.
--                 deleted_at marks the ROOT of a trashed subtree (soft delete).
--   node_history  every insert/update/delete of a node, written by a trigger.
--                 This is the per-node undo/restore log.
--
-- Security: Row Level Security is ON for every table. Nothing is readable or
-- writable without a logged-in user whose profile status is 'approved',
-- except that a pending user may read their own profile row (so the app can
-- show them "awaiting approval").
-- =============================================================================


-- ---------- Enumerations ------------------------------------------------------
create type public.user_role   as enum ('admin', 'editor');
create type public.user_status as enum ('pending', 'approved', 'rejected');
create type public.node_kind   as enum ('question', 'finding', 'note');


-- ---------- Tables ------------------------------------------------------------
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text not null unique,
  display_name  text not null,
  role          public.user_role   not null default 'editor',
  status        public.user_status not null default 'pending',
  created_at    timestamptz not null default now(),
  approved_at   timestamptz,
  approved_by   uuid references public.profiles (id)
);

create table public.app_settings (
  key    text primary key,
  value  jsonb not null
);

-- Emails in this list become approved admins automatically on signup.
-- Edit the list here, or later via: update app_settings set value = '[...]'
-- where key = 'bootstrap_admins';
insert into public.app_settings (key, value)
values ('bootstrap_admins', '["julianastanley25@gmail.com"]');

create table public.nodes (
  id          uuid primary key default gen_random_uuid(),
  parent_id   uuid references public.nodes (id) on delete cascade,
  -- Fractional ordering among siblings: inserting between 1 and 2 gives 1.5.
  position    double precision not null default 0,
  text        text not null default '',
  kind        public.node_kind not null default 'question',
  created_by  uuid references public.profiles (id),
  updated_by  uuid references public.profiles (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Soft delete. Set on the top node of a trashed subtree only; descendants
  -- are hidden because an ancestor is deleted, not because they are marked.
  deleted_at  timestamptz,
  deleted_by  uuid references public.profiles (id)
);
create index nodes_parent_idx  on public.nodes (parent_id);
create index nodes_deleted_idx on public.nodes (deleted_at) where deleted_at is not null;

create table public.node_history (
  id          bigint generated always as identity primary key,
  node_id     uuid not null,                -- not a FK: survives a purge
  op          text not null check (op in ('insert', 'update', 'delete')),
  data        jsonb not null,               -- the row as it was BEFORE the change
                                            -- (for 'insert', the row as created)
  changed_by  uuid,
  changed_at  timestamptz not null default now()
);
create index node_history_node_idx on public.node_history (node_id, changed_at desc);


-- ---------- Helper functions --------------------------------------------------
-- SECURITY DEFINER so they can read profiles without tripping RLS recursion.
create or replace function public.is_approved()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and status = 'approved'
  );
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and status = 'approved' and role = 'admin'
  );
$$;


-- ---------- Trigger: create a profile when a user signs up --------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  is_bootstrap boolean;
begin
  select coalesce(
    (select value ? lower(new.email) from public.app_settings where key = 'bootstrap_admins'),
    false
  ) into is_bootstrap;

  insert into public.profiles (id, email, display_name, role, status, approved_at)
  values (
    new.id,
    lower(new.email),
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1)),
    case when is_bootstrap then 'admin'::public.user_role   else 'editor'::public.user_role   end,
    case when is_bootstrap then 'approved'::public.user_status else 'pending'::public.user_status end,
    case when is_bootstrap then now() else null end
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ---------- Trigger: protect role/status on profiles --------------------------
-- Non-admins may edit their own display_name but never role or status.
-- Nobody may remove the last approved admin (prevents lock-out).
create or replace function public.guard_profile_update()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  admin_count int;
begin
  if (new.role <> old.role or new.status <> old.status) and not public.is_admin() then
    raise exception 'Only admins can change role or status';
  end if;
  if new.email <> old.email or new.id <> old.id then
    raise exception 'Email and id are immutable';
  end if;
  if old.role = 'admin' and old.status = 'approved'
     and (new.role <> 'admin' or new.status <> 'approved') then
    select count(*) into admin_count
      from public.profiles where role = 'admin' and status = 'approved';
    if admin_count <= 1 then
      raise exception 'Cannot remove the last admin';
    end if;
  end if;
  if new.status = 'approved' and old.status <> 'approved' then
    new.approved_at := now();
    new.approved_by := auth.uid();
  end if;
  return new;
end;
$$;

create trigger profiles_guard
  before update on public.profiles
  for each row execute function public.guard_profile_update();


-- ---------- Trigger: bookkeeping columns on nodes -----------------------------
create or replace function public.nodes_bookkeeping()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
    new.updated_by := coalesce(new.updated_by, auth.uid());
    new.created_at := now();
    new.updated_at := now();
  else
    new.created_by := old.created_by;      -- immutable
    new.created_at := old.created_at;
    new.updated_by := auth.uid();
    new.updated_at := now();
    if new.deleted_at is not null and old.deleted_at is null then
      new.deleted_by := auth.uid();
    elsif new.deleted_at is null then
      new.deleted_by := null;
    end if;
  end if;
  return new;
end;
$$;

create trigger nodes_bookkeeping
  before insert or update on public.nodes
  for each row execute function public.nodes_bookkeeping();


-- ---------- Trigger: write history --------------------------------------------
create or replace function public.nodes_record_history()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.node_history (node_id, op, data, changed_by)
    values (new.id, 'insert', to_jsonb(new), auth.uid());
    return new;
  elsif tg_op = 'UPDATE' then
    -- Skip no-op updates (e.g. realtime echo) to keep history meaningful.
    if row(new.parent_id, new.position, new.text, new.kind, new.deleted_at)
       is not distinct from
       row(old.parent_id, old.position, old.text, old.kind, old.deleted_at) then
      return new;
    end if;
    insert into public.node_history (node_id, op, data, changed_by)
    values (old.id, 'update', to_jsonb(old), auth.uid());
    return new;
  else
    insert into public.node_history (node_id, op, data, changed_by)
    values (old.id, 'delete', to_jsonb(old), auth.uid());
    return old;
  end if;
end;
$$;

create trigger nodes_history
  after insert or update or delete on public.nodes
  for each row execute function public.nodes_record_history();


-- ---------- Row Level Security ------------------------------------------------
alter table public.profiles     enable row level security;
alter table public.app_settings enable row level security;
alter table public.nodes        enable row level security;
alter table public.node_history enable row level security;

-- profiles
create policy "profiles: approved users read all, others read self"
  on public.profiles for select
  using (public.is_approved() or id = auth.uid());

create policy "profiles: users edit own row, admins edit any"
  on public.profiles for update
  using  (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());
-- (inserts happen only via the signup trigger; deletes only via auth.users cascade)

-- app_settings
create policy "settings: approved read"  on public.app_settings for select using (public.is_approved());
create policy "settings: admin write"    on public.app_settings for update using (public.is_admin()) with check (public.is_admin());
create policy "settings: admin insert"   on public.app_settings for insert with check (public.is_admin());

-- nodes
create policy "nodes: approved read"   on public.nodes for select using (public.is_approved());
create policy "nodes: approved insert" on public.nodes for insert with check (public.is_approved());
create policy "nodes: approved update" on public.nodes for update using (public.is_approved()) with check (public.is_approved());
-- Hard delete = "purge from trash". Admins only, and only already-trashed nodes.
create policy "nodes: admin purge"     on public.nodes for delete using (public.is_admin() and deleted_at is not null);

-- node_history: read-only for users; rows are written by the trigger above.
create policy "history: approved read" on public.node_history for select using (public.is_approved());


-- ---------- Realtime ----------------------------------------------------------
-- Lets every open browser see other people's edits live. RLS still applies.
alter publication supabase_realtime add table public.nodes;
alter publication supabase_realtime add table public.profiles;
