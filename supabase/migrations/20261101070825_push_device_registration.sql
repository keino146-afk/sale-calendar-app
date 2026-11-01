-- Push device registration tables (roadmap 3, U1-A).
--
-- A device registration (private.push_device_registrations) becomes active
-- only after a server-side check of both a request secret and a nonce sent
-- by push; until then it is a request (private.push_registration_requests).
-- Both tables live in schema private (not exposed through the Data API),
-- have RLS enabled with no policies and grant nothing to any client role,
-- service_role included. Later SECURITY DEFINER RPCs will be the only way
-- to change them; this migration adds no RPC.
--
-- Only hashes of secrets and nonces are stored, and the push token itself
-- is kept only while it is needed: a disabled registration and a closed
-- request must not keep it. Hash lengths are bounded but not fixed, as the
-- hash method is not decided here.
--
-- Expiry is never a stored state: a registration or request has expired
-- when now() >= expires_at. Closing expired pending requests, the request
-- lifetime and the attempt limit belong to the later RPCs.

-- ============================================================
-- Tables
-- ============================================================

-- Active: may receive automatic pushes once the other conditions hold.
-- Disabled: never active again (a new registration is needed).
create table private.push_device_registrations (
  id uuid primary key default gen_random_uuid(),
  status text not null,
  push_token text null,
  push_token_hash bytea null,
  secret_hash bytea null,
  -- 1 when first confirmed; +1 each time a new token is confirmed.
  confirmed_token_generation integer not null,
  -- Sending paused until a new token is confirmed (B3).
  send_paused boolean not null,
  notifications_enabled boolean not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz null,
  disabled_reason text null,
  constraint push_device_registrations_status_valid check (
    status in ('active', 'disabled')
  ),
  constraint push_device_registrations_push_token_bytes check (
    octet_length(push_token) between 1 and 1024
  ),
  constraint push_device_registrations_push_token_hash_bytes check (
    octet_length(push_token_hash) between 1 and 64
  ),
  constraint push_device_registrations_secret_hash_bytes check (
    octet_length(secret_hash) between 1 and 64
  ),
  constraint push_device_registrations_generation_positive check (
    confirmed_token_generation >= 1
  ),
  constraint push_device_registrations_expires_after_created check (
    expires_at > created_at
  ),
  constraint push_device_registrations_disabled_reason_format check (
    disabled_reason ~ '^[a-z][a-z0-9_]{0,63}$'
  ),
  -- A disabled registration keeps no token and no secret; it may keep the
  -- token hash.
  constraint push_device_registrations_status_fields check (
    (status = 'active'
      and push_token is not null
      and push_token_hash is not null
      and secret_hash is not null
      and disabled_at is null
      and disabled_reason is null)
    or
    (status = 'disabled'
      and disabled_at is not null
      and disabled_reason is not null
      and push_token is null
      and secret_hash is null)
  )
);

-- One active registration per token.
create unique index push_device_registrations_active_token_uidx
  on private.push_device_registrations (push_token_hash)
  where status = 'active';

-- A request to register a new device or to change the token of one.
-- Pending: may still be confirmed. Consumed, expired, cancelled: closed for
-- good, with the token, the request secret hash and the nonce hash gone.
create table private.push_registration_requests (
  id uuid primary key default gen_random_uuid(),
  purpose text not null,
  -- The registration whose token changes; null for a new registration.
  registration_id uuid null
    references private.push_device_registrations (id) on delete restrict,
  push_token text null,
  -- Kept after closing, to count requests per token.
  push_token_hash bytea not null,
  request_secret_hash bytea null,
  nonce_hash bytea null,
  state text not null,
  expires_at timestamptz not null,
  failed_attempts integer not null default 0,
  closed_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint push_registration_requests_purpose_valid check (
    purpose in ('new', 'token_change')
  ),
  constraint push_registration_requests_state_valid check (
    state in ('pending', 'consumed', 'expired', 'cancelled')
  ),
  constraint push_registration_requests_push_token_bytes check (
    octet_length(push_token) between 1 and 1024
  ),
  constraint push_registration_requests_push_token_hash_bytes check (
    octet_length(push_token_hash) between 1 and 64
  ),
  constraint push_registration_requests_request_secret_hash_bytes check (
    octet_length(request_secret_hash) between 1 and 64
  ),
  constraint push_registration_requests_nonce_hash_bytes check (
    octet_length(nonce_hash) between 1 and 64
  ),
  constraint push_registration_requests_failed_attempts_non_negative check (
    failed_attempts >= 0
  ),
  constraint push_registration_requests_expires_after_created check (
    expires_at > created_at
  ),
  constraint push_registration_requests_purpose_registration check (
    (purpose = 'token_change') = (registration_id is not null)
  ),
  constraint push_registration_requests_state_fields check (
    (state = 'pending'
      and push_token is not null
      and request_secret_hash is not null
      and nonce_hash is not null
      and closed_at is null)
    or
    (state <> 'pending'
      and closed_at is not null
      and push_token is null
      and request_secret_hash is null
      and nonce_hash is null)
  )
);

-- At most one pending request per token and per registration. Only state
-- is in the predicate (not now()): an expired request stays pending until
-- an RPC closes it.
create unique index push_registration_requests_pending_token_uidx
  on private.push_registration_requests (push_token_hash)
  where state = 'pending';

create unique index push_registration_requests_pending_registration_uidx
  on private.push_registration_requests (registration_id)
  where state = 'pending' and registration_id is not null;

-- Request counts per token and overall.
create index push_registration_requests_token_created_at_idx
  on private.push_registration_requests (push_token_hash, created_at);

create index push_registration_requests_created_at_idx
  on private.push_registration_requests (created_at);

-- ============================================================
-- Transition guards
-- ============================================================

-- A disabled registration is never reactivated, and the confirmed token
-- generation only stays the same or goes up by exactly one.
create function private.enforce_push_device_registration_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'disabled' and new.status = 'active' then
    raise exception 'disabled push device registrations cannot be reactivated'
      using errcode = '55000';
  end if;

  if new.confirmed_token_generation <> old.confirmed_token_generation
    and new.confirmed_token_generation::bigint <> old.confirmed_token_generation::bigint + 1 then
    raise exception 'confirmed token generation may only stay the same or increase by one'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

-- A closed request never changes state again (no return to pending, no
-- change between closed states).
create function private.enforce_push_registration_request_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.state <> 'pending' and new.state <> old.state then
    raise exception 'closed push registration requests cannot change state: % -> %', old.state, new.state
      using errcode = '55000';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_push_device_registration_transition()
  from public, anon, authenticated, service_role;
revoke all on function private.enforce_push_registration_request_transition()
  from public, anon, authenticated, service_role;

-- ============================================================
-- Triggers (same-timing triggers fire in name order)
-- ============================================================

create trigger push_device_registrations_20_transition
  before update on private.push_device_registrations
  for each row execute function private.enforce_push_device_registration_transition();

create trigger push_device_registrations_30_updated_at
  before update on private.push_device_registrations
  for each row execute function private.set_updated_at();

create trigger push_registration_requests_20_transition
  before update on private.push_registration_requests
  for each row execute function private.enforce_push_registration_request_transition();

-- ============================================================
-- Row level security and grants (no client access, no policies)
-- ============================================================

alter table private.push_device_registrations enable row level security;
alter table private.push_registration_requests enable row level security;

revoke all on table private.push_device_registrations
  from public, anon, authenticated, service_role;
revoke all on table private.push_registration_requests
  from public, anon, authenticated, service_role;
