-- Initial schema for sale-calendar-app.
--
-- Public reads go through RLS with explicit grants. Lifecycle (status)
-- changes are only possible through the four security definer RPCs below.
-- Internal review data (reject reasons, actors) lives only in
-- public.sale_event_audit, which only admins can read.

-- ============================================================
-- Private schema (not exposed through the Data API)
-- ============================================================

create schema if not exists private;

revoke all on schema private from public;
grant usage on schema private to authenticated;

-- ============================================================
-- Tables
-- ============================================================

create table public.retailers (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  official_base_url text not null,
  sort_order smallint not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint retailers_slug_not_blank check (
    char_length(regexp_replace(normalize(slug, NFKC), '[[:space:]]+', '', 'g')) > 0
  ),
  constraint retailers_name_not_blank check (
    char_length(regexp_replace(normalize(name, NFKC), '[[:space:]]+', '', 'g')) > 0
  ),
  constraint retailers_official_base_url_https check (
    official_base_url ~ '^https://'
    and char_length(official_base_url) <= 2048
  )
);

create table public.sale_events (
  id uuid primary key default gen_random_uuid(),
  retailer_id uuid not null references public.retailers (id) on delete restrict,
  title text not null,
  description text null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  is_date_only boolean not null default false,
  status text not null default 'pending_review',
  source_url text not null,
  source_checked_at timestamptz null,
  published_at timestamptz null,
  rejected_at timestamptz null,
  archived_at timestamptz null,
  -- Set only by private.set_sale_event_derived(); never granted to clients.
  title_key text not null,
  start_date_jst date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint sale_events_title_length check (
    char_length(regexp_replace(normalize(title, NFKC), '[[:space:]]+', '', 'g')) between 1 and 200
  ),
  constraint sale_events_description_length check (
    description is null or char_length(description) <= 5000
  ),
  constraint sale_events_ends_after_starts check (ends_at > starts_at),
  constraint sale_events_status_valid check (
    status in ('pending_review', 'published', 'rejected', 'archived')
  ),
  constraint sale_events_source_url_https check (
    source_url ~ '^https://'
    and char_length(source_url) <= 2048
  ),
  constraint sale_events_status_timestamps check (
    (status = 'pending_review'
      and published_at is null and rejected_at is null and archived_at is null)
    or (status = 'published'
      and published_at is not null and rejected_at is null and archived_at is null)
    or (status = 'rejected'
      and published_at is null and rejected_at is not null and archived_at is null)
    or (status = 'archived'
      and published_at is not null and rejected_at is null and archived_at is not null)
  )
);

create table public.admin_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- actor_user_id intentionally has no FK so history survives Auth user deletion.
create table public.sale_event_audit (
  id bigint generated always as identity primary key,
  sale_event_id uuid not null references public.sale_events (id) on delete restrict,
  action text not null,
  actor_user_id uuid null,
  old_data jsonb null,
  new_data jsonb null,
  note text null,
  created_at timestamptz not null default now(),

  constraint sale_event_audit_action_valid check (
    action in ('create', 'update', 'publish', 'reject', 'archive', 'reopen')
  ),
  constraint sale_event_audit_note_length check (
    note is null or char_length(note) <= 2000
  )
);

-- ============================================================
-- Indexes
-- ============================================================

-- At most one active (pending_review / published) event per
-- retailer + normalized title + JST start date.
create unique index sale_events_active_dedup_uidx
  on public.sale_events (retailer_id, title_key, start_date_jst)
  where status in ('pending_review', 'published');

create index sale_events_published_starts_at_idx
  on public.sale_events (starts_at)
  where status = 'published';

create index sale_events_published_retailer_starts_at_idx
  on public.sale_events (retailer_id, starts_at)
  where status = 'published';

create index sale_events_status_created_at_idx
  on public.sale_events (status, created_at);

create index sale_event_audit_sale_event_id_created_at_idx
  on public.sale_event_audit (sale_event_id, created_at);

-- ============================================================
-- Private functions
-- ============================================================

create function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admin_users
    where user_id = (select auth.uid())
  );
$$;

create function private.set_sale_event_derived()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.title_key := pg_catalog.lower(
    pg_catalog.regexp_replace(normalize(new.title, NFKC), '[[:space:]]+', '', 'g')
  );
  new.start_date_jst := (new.starts_at at time zone 'Asia/Tokyo')::date;
  return new;
end;
$$;

create function private.enforce_sale_event_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Archived rows are fully immutable (status and content).
  if old.status = 'archived' then
    raise exception 'archived sale events cannot be modified'
      using errcode = '55000';
  end if;

  -- Content edit on pending_review / published / rejected.
  if new.status = old.status then
    return new;
  end if;

  if old.status = 'pending_review' and new.status = 'published' then
    new.published_at := pg_catalog.now();
    new.rejected_at := null;
    new.archived_at := null;
  elsif old.status = 'pending_review' and new.status = 'rejected' then
    new.published_at := null;
    new.rejected_at := pg_catalog.now();
    new.archived_at := null;
  elsif old.status = 'published' and new.status = 'archived' then
    new.published_at := old.published_at;
    new.rejected_at := null;
    new.archived_at := pg_catalog.now();
  elsif old.status = 'rejected' and new.status = 'pending_review' then
    new.published_at := null;
    new.rejected_at := null;
    new.archived_at := null;
  else
    raise exception 'invalid sale event status transition: % -> %', old.status, new.status
      using errcode = '55000';
  end if;

  return new;
end;
$$;

create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

create function private.log_sale_event_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text;
  v_note text;
  v_old_data jsonb;
begin
  if tg_op = 'INSERT' then
    v_action := 'create';
    v_old_data := null;
  else
    v_old_data := pg_catalog.to_jsonb(old);

    if old.status is distinct from new.status then
      v_action := case
        when old.status = 'pending_review' and new.status = 'published' then 'publish'
        when old.status = 'pending_review' and new.status = 'rejected' then 'reject'
        when old.status = 'published' and new.status = 'archived' then 'archive'
        when old.status = 'rejected' and new.status = 'pending_review' then 'reopen'
      end;

      if v_action is null then
        raise exception 'unexpected sale event status transition: % -> %', old.status, new.status
          using errcode = '55000';
      end if;
    elsif (old.retailer_id, old.title, old.description, old.starts_at, old.ends_at,
           old.is_date_only, old.source_url, old.source_checked_at)
          is distinct from
          (new.retailer_id, new.title, new.description, new.starts_at, new.ends_at,
           new.is_date_only, new.source_url, new.source_checked_at) then
      v_action := 'update';
    else
      -- Only updated_at / derived columns changed: not a meaningful update.
      return null;
    end if;
  end if;

  -- Decide the note only after the action, so a reject reason can never
  -- leak into any other action's audit row.
  if v_action = 'reject' then
    v_note := nullif(pg_catalog.current_setting('app.audit_note', true), '');
  else
    v_note := null;
  end if;

  insert into public.sale_event_audit
    (sale_event_id, action, actor_user_id, old_data, new_data, note)
  values
    (new.id, v_action, auth.uid(), v_old_data, pg_catalog.to_jsonb(new), v_note);

  return null;
end;
$$;

revoke all on function private.is_admin() from public, anon;
grant execute on function private.is_admin() to authenticated;

revoke all on function private.set_sale_event_derived() from public, anon, authenticated;
revoke all on function private.enforce_sale_event_transition() from public, anon, authenticated;
revoke all on function private.set_updated_at() from public, anon, authenticated;
revoke all on function private.log_sale_event_change() from public, anon, authenticated;

-- ============================================================
-- Triggers (same-timing triggers fire in name order)
-- ============================================================

create trigger sale_events_10_derive
  before insert or update of title, starts_at on public.sale_events
  for each row execute function private.set_sale_event_derived();

create trigger sale_events_20_transition
  before update on public.sale_events
  for each row execute function private.enforce_sale_event_transition();

create trigger sale_events_30_updated_at
  before update on public.sale_events
  for each row execute function private.set_updated_at();

create trigger sale_events_90_audit
  after insert or update on public.sale_events
  for each row execute function private.log_sale_event_change();

create trigger retailers_30_updated_at
  before update on public.retailers
  for each row execute function private.set_updated_at();

-- ============================================================
-- Lifecycle RPCs (the only way to change sale_events.status)
-- ============================================================

create function public.publish_sale_event(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;

  perform pg_catalog.set_config('app.audit_note', '', true);

  update public.sale_events
  set status = 'published'
  where id = p_id
    and status = 'pending_review';

  if not found then
    raise exception 'sale event not found or not pending_review' using errcode = 'P0002';
  end if;
end;
$$;

create function public.reject_sale_event(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
begin
  if not private.is_admin() then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;

  perform pg_catalog.set_config('app.audit_note', '', true);

  -- NFKC (full-width space -> space), then trim leading/trailing whitespace
  -- (incl. tab/newline). Internal whitespace is preserved.
  v_reason := normalize(p_reason, NFKC);
  v_reason := pg_catalog.regexp_replace(v_reason, '^[[:space:]]+', '');
  v_reason := pg_catalog.regexp_replace(v_reason, '[[:space:]]+$', '');

  if v_reason is null or v_reason = '' then
    raise exception 'reject reason is required' using errcode = '22023';
  end if;

  if pg_catalog.char_length(v_reason) > 2000 then
    raise exception 'reject reason must be 2000 characters or fewer' using errcode = '22023';
  end if;

  perform pg_catalog.set_config('app.audit_note', v_reason, true);

  update public.sale_events
  set status = 'rejected'
  where id = p_id
    and status = 'pending_review';

  if not found then
    raise exception 'sale event not found or not pending_review' using errcode = 'P0002';
  end if;
end;
$$;

create function public.archive_sale_event(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;

  perform pg_catalog.set_config('app.audit_note', '', true);

  update public.sale_events
  set status = 'archived'
  where id = p_id
    and status = 'published';

  if not found then
    raise exception 'sale event not found or not published' using errcode = 'P0002';
  end if;
end;
$$;

-- A duplicate active event makes this fail with 23505 by design.
create function public.reopen_sale_event(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;

  perform pg_catalog.set_config('app.audit_note', '', true);

  update public.sale_events
  set status = 'pending_review'
  where id = p_id
    and status = 'rejected';

  if not found then
    raise exception 'sale event not found or not rejected' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.publish_sale_event(uuid) from public, anon;
revoke all on function public.reject_sale_event(uuid, text) from public, anon;
revoke all on function public.archive_sale_event(uuid) from public, anon;
revoke all on function public.reopen_sale_event(uuid) from public, anon;

grant execute on function public.publish_sale_event(uuid) to authenticated;
grant execute on function public.reject_sale_event(uuid, text) to authenticated;
grant execute on function public.archive_sale_event(uuid) to authenticated;
grant execute on function public.reopen_sale_event(uuid) to authenticated;

-- ============================================================
-- Row level security
-- ============================================================

alter table public.retailers enable row level security;
alter table public.sale_events enable row level security;
alter table public.admin_users enable row level security;
alter table public.sale_event_audit enable row level security;

create policy retailers_public_active_read
  on public.retailers
  for select
  to anon, authenticated
  using (is_active = true);

create policy retailers_admin_read
  on public.retailers
  for select
  to authenticated
  using ((select private.is_admin()));

create policy sale_events_public_published_read
  on public.sale_events
  for select
  to anon, authenticated
  using (status = 'published');

create policy sale_events_admin_read
  on public.sale_events
  for select
  to authenticated
  using ((select private.is_admin()));

create policy sale_events_admin_insert
  on public.sale_events
  for insert
  to authenticated
  with check ((select private.is_admin()));

create policy sale_events_admin_update
  on public.sale_events
  for update
  to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

-- public.admin_users: RLS enabled with no policies (no client access).

create policy sale_event_audit_admin_read
  on public.sale_event_audit
  for select
  to authenticated
  using ((select private.is_admin()));

-- ============================================================
-- Table grants (explicit; nothing is exposed by default)
-- ============================================================

revoke all on table public.retailers from anon, authenticated;
revoke all on table public.sale_events from anon, authenticated;
revoke all on table public.admin_users from anon, authenticated;
revoke all on table public.sale_event_audit from anon, authenticated;

grant select on table public.retailers to anon, authenticated;
grant select on table public.sale_events to anon, authenticated;
grant select on table public.sale_event_audit to authenticated;

grant insert (
  retailer_id,
  title,
  description,
  starts_at,
  ends_at,
  is_date_only,
  source_url,
  source_checked_at
) on table public.sale_events to authenticated;

grant update (
  retailer_id,
  title,
  description,
  starts_at,
  ends_at,
  is_date_only,
  source_url,
  source_checked_at
) on table public.sale_events to authenticated;

-- ============================================================
-- Required retailer master data
-- ============================================================

insert into public.retailers (slug, name, official_base_url, sort_order, is_active)
values
  ('rakuten', '楽天市場', 'https://www.rakuten.co.jp/', 10, true),
  ('amazon', 'Amazon', 'https://www.amazon.co.jp/', 20, true),
  ('qoo10', 'Qoo10', 'https://www.qoo10.jp/', 30, true)
on conflict (slug) do nothing;
