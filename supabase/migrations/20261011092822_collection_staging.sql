-- Collection staging foundation (Phase 5B).
--
-- Automated collectors never write sale_events. They submit what they found
-- to public.collection_candidates through one SECURITY DEFINER RPC, and an
-- admin later decides what to import (a later phase). Candidates are not
-- public and carry no sale lifecycle status.
--
-- Collector identities and source policy live in schema private (not exposed
-- through the Data API). No source is enabled and no collector exists after
-- this migration.

-- ============================================================
-- Private tables
-- ============================================================

-- Auth users allowed to submit candidates. Completely separate from
-- admin_users: a collector is not an admin.
create table private.collector_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Allowed sources. A candidate's URL must be on expected_host and match
-- source_url_pattern, which can pin a publisher (e.g. one company id on a
-- press-release site), not just a domain.
create table private.collection_sources (
  id text primary key,
  retailer_id uuid not null references public.retailers (id) on delete restrict,
  expected_host text not null,
  source_url_pattern text not null,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),

  constraint collection_sources_id_format check (id ~ '^[a-z0-9][a-z0-9_-]{1,62}$'),
  constraint collection_sources_host_format check (
    expected_host ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
    and char_length(expected_host) <= 253
  ),
  constraint collection_sources_pattern_anchored check (
    source_url_pattern like '^https://%'
    and source_url_pattern like '%$'
    and char_length(source_url_pattern) <= 500
  )
);

alter table private.collector_users enable row level security;
alter table private.collection_sources enable row level security;

revoke all on table private.collector_users from public, anon, authenticated;
revoke all on table private.collection_sources from public, anon, authenticated;

-- ============================================================
-- Candidates
-- ============================================================

create table public.collection_candidates (
  id uuid primary key default gen_random_uuid(),
  source_id text not null references private.collection_sources (id) on delete restrict,
  external_key text not null,
  retailer_id uuid not null references public.retailers (id) on delete restrict,
  source_url text not null,
  title text not null,
  description text null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  is_date_only boolean not null,
  source_checked_at timestamptz not null,
  evidence_excerpt text not null,
  -- Hash of the content first seen; never changed after insert.
  content_hash text not null,
  -- Hash of the content seen most recently.
  last_seen_content_hash text not null,
  parser_version text not null,
  -- Set once the source content differs from what was first seen (sticky).
  source_changed boolean not null default false,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  review_state text not null default 'new',
  imported_sale_event_id uuid null references public.sale_events (id) on delete restrict,

  constraint collection_candidates_identity unique (source_id, external_key),
  constraint collection_candidates_external_key_format check (
    external_key ~ '^[[:graph:]]+$' and char_length(external_key) <= 2048
  ),
  constraint collection_candidates_source_url_https check (
    source_url ~ '^https://' and char_length(source_url) <= 2048
  ),
  constraint collection_candidates_title_length check (
    char_length(regexp_replace(normalize(title, NFKC), '[[:space:]]+', '', 'g')) between 1 and 200
  ),
  constraint collection_candidates_description_length check (
    description is null or char_length(description) <= 5000
  ),
  constraint collection_candidates_ends_after_starts check (ends_at > starts_at),
  constraint collection_candidates_evidence_length check (
    char_length(evidence_excerpt) between 1 and 2000
  ),
  constraint collection_candidates_content_hash_format check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint collection_candidates_last_hash_format check (last_seen_content_hash ~ '^[0-9a-f]{64}$'),
  constraint collection_candidates_parser_version_format check (
    parser_version ~ '^[A-Za-z0-9._-]{1,40}$'
  ),
  constraint collection_candidates_review_state_valid check (
    review_state in ('new', 'imported', 'dismissed')
  ),
  constraint collection_candidates_import_link check (
    (review_state = 'imported') = (imported_sale_event_id is not null)
  )
);

create index collection_candidates_review_state_last_seen_idx
  on public.collection_candidates (review_state, last_seen_at desc);

alter table public.collection_candidates enable row level security;

-- Admins may read candidates; nobody writes them directly.
create policy collection_candidates_admin_read
  on public.collection_candidates
  for select
  to authenticated
  using ((select private.is_admin()));

revoke all on table public.collection_candidates from public, anon, authenticated;
grant select on table public.collection_candidates to authenticated;

-- ============================================================
-- Collector check
-- ============================================================

create function private.is_collector()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.collector_users
    where user_id = (select auth.uid())
      and is_active
  );
$$;

-- Only called from the SECURITY DEFINER RPC below; no client role needs it.
revoke all on function private.is_collector() from public, anon, authenticated;

-- ============================================================
-- Candidate submission RPC (the only write path)
-- ============================================================

-- Returns 'inserted', 'seen' (same content as last time) or 'changed'
-- (content differs from what was first seen). Existing candidate content is
-- never overwritten, and sale_events is never touched.
create function public.submit_collection_candidate(
  p_source_id text,
  p_external_key text,
  p_retailer_id uuid,
  p_source_url text,
  p_title text,
  p_description text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_is_date_only boolean,
  p_source_checked_at timestamptz,
  p_evidence_excerpt text,
  p_content_hash text,
  p_parser_version text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source private.collection_sources%rowtype;
  v_host text;
  v_existing public.collection_candidates%rowtype;
begin
  if not private.is_collector() then
    raise exception 'insufficient privilege' using errcode = '42501';
  end if;

  select * into v_source from private.collection_sources where id = p_source_id;
  if not found then
    raise exception 'unknown source' using errcode = '22023';
  end if;
  if not v_source.enabled then
    raise exception 'source is disabled' using errcode = '55000';
  end if;
  if p_retailer_id is distinct from v_source.retailer_id then
    raise exception 'retailer does not match source' using errcode = '22023';
  end if;

  -- https only, no credentials or port, exact host, and the source's pattern.
  v_host := pg_catalog.lower(pg_catalog.substring(p_source_url, '^https://([^/?#]*)'));
  if v_host is null or v_host is distinct from v_source.expected_host
     or p_source_url !~ v_source.source_url_pattern
     or pg_catalog.char_length(p_source_url) > 2048 then
    raise exception 'source url not allowed for source' using errcode = '22023';
  end if;

  if p_external_key is null or p_external_key !~ '^[[:graph:]]+$'
     or pg_catalog.char_length(p_external_key) > 2048 then
    raise exception 'invalid external key' using errcode = '22023';
  end if;
  if p_content_hash is null or p_content_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid content hash' using errcode = '22023';
  end if;
  if p_parser_version is null or p_parser_version !~ '^[A-Za-z0-9._-]{1,40}$' then
    raise exception 'invalid parser version' using errcode = '22023';
  end if;
  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then
    raise exception 'invalid period' using errcode = '22023';
  end if;
  if p_source_checked_at is null or p_source_checked_at > pg_catalog.now() + interval '10 minutes' then
    raise exception 'invalid checked time' using errcode = '22023';
  end if;
  if p_is_date_only is null or p_evidence_excerpt is null then
    raise exception 'missing field' using errcode = '22023';
  end if;

  select * into v_existing
  from public.collection_candidates
  where source_id = p_source_id and external_key = p_external_key
  for update;

  if not found then
    -- Remaining bounds (title, description, evidence) are table constraints.
    insert into public.collection_candidates (
      source_id, external_key, retailer_id, source_url, title, description,
      starts_at, ends_at, is_date_only, source_checked_at, evidence_excerpt,
      content_hash, last_seen_content_hash, parser_version
    ) values (
      p_source_id, p_external_key, p_retailer_id, p_source_url, p_title, p_description,
      p_starts_at, p_ends_at, p_is_date_only, p_source_checked_at, p_evidence_excerpt,
      p_content_hash, p_content_hash, p_parser_version
    );
    return 'inserted';
  end if;

  update public.collection_candidates
  set last_seen_at = pg_catalog.now(),
      last_seen_content_hash = p_content_hash,
      source_changed = source_changed or (p_content_hash <> content_hash)
  where id = v_existing.id;

  if p_content_hash = v_existing.content_hash then
    return 'seen';
  end if;
  return 'changed';
end;
$$;

revoke all on function public.submit_collection_candidate(
  text, text, uuid, text, text, text, timestamptz, timestamptz, boolean, timestamptz, text, text, text
) from public, anon;
grant execute on function public.submit_collection_candidate(
  text, text, uuid, text, text, text, timestamptz, timestamptz, boolean, timestamptz, text, text, text
) to authenticated;
