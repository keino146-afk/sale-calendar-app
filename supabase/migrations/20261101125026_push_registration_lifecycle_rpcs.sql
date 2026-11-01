-- Push registration renewal, disabling and token change RPCs (roadmap 3, U1-C).
--
-- public.renew_push_registration (anon only) extends an active registration
-- by 90 x 24 hours once at most 45 x 24 hours remain, under the U0 rules.
-- public.disable_push_registration (anon only) disables one for good. Both
-- need the registration secret returned by confirm_push_registration; the
-- OS permission and the device check are reported by the device and only
-- refuse when not true, they prove nothing.
--
-- A token change is confirmed through two paths, as a new registration is:
-- public.create_push_token_change_request (service_role only) pauses
-- sending (B3) and records a pending token_change request, whose nonce the
-- caller sends only in a confirmation push to the new token;
-- public.confirm_push_token_change (anon only) then needs the request
-- secret, the nonce and the registration secret. Only that confirmation
-- resumes sending, moving the registration to the new token and raising its
-- confirmed token generation by one; it never extends the expiry, and a
-- registration that expired or was disabled meanwhile stays so.
--
-- private.push_token_change_open() closes the confirmation path. It only
-- returns false here: it opens only through a later, approved migration
-- with the usage-monitoring check (P6), separate from registration intake.
-- While it is closed, a token change still pauses sending and cancels the
-- registration's pending token_change requests, but creates none, so no
-- confirmation push is asked for, and nothing is confirmed.
--
-- Renewal, disabling and pausing write to the database only and send
-- nothing, so they do not depend on either gate.
--
-- Lock order, as in U1-B: global advisory lock, then per-token advisory
-- lock, then push_registration_requests rows (FOR UPDATE), then
-- push_device_registrations rows (FOR NO KEY UPDATE, several in id order).
-- Each RPC takes its time from private.push_registration_current_time()
-- once its locks are held and checks again what may have changed while it
-- waited. Rows skipped while waiting (READ COMMITTED) are not acted on.
--
-- Unauthorized calls (unknown id, wrong secret, or a disabled registration,
-- which keeps no secret) get one result, so the state is not revealed.
-- Secrets, nonces and tokens never appear in results or error messages.
--
-- The registration transition guard is replaced with a stronger one: the
-- token generation, the token and the pause on an active registration
-- change only together, as a confirmation does.

-- ============================================================
-- Helper (not callable by clients)
-- ============================================================

-- Closed. Opening it needs a new migration with the P6 check.
create function private.push_token_change_open()
returns boolean
language sql
stable
set search_path = ''
as $$ select false $$;

revoke all on function private.push_token_change_open()
  from public, anon, authenticated, service_role;

-- ============================================================
-- Transition guard (replaced)
-- ============================================================

-- A disabled registration is never reactivated. The confirmed token
-- generation goes up only by exactly one, and only when a paused active
-- registration resumes with it (a confirmed token); resuming needs that
-- step, and so does changing the token of an active registration.
create or replace function private.enforce_push_device_registration_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_confirmation boolean;
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

  v_confirmation := old.status = 'active' and new.status = 'active'
    and old.send_paused and not new.send_paused
    and new.confirmed_token_generation::bigint = old.confirmed_token_generation::bigint + 1;

  if new.confirmed_token_generation <> old.confirmed_token_generation and not v_confirmation then
    raise exception 'confirmed token generation changes only when a paused registration resumes'
      using errcode = '55000';
  end if;

  if old.send_paused and not new.send_paused and not v_confirmation then
    raise exception 'a paused registration resumes only with a new confirmed token generation'
      using errcode = '55000';
  end if;

  if old.status = 'active' and new.status = 'active'
    and (new.push_token is distinct from old.push_token
      or new.push_token_hash is distinct from old.push_token_hash)
    and not v_confirmation then
    raise exception 'the token of an active registration changes only with a new confirmed token generation'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_push_device_registration_transition()
  from public, anon, authenticated, service_role;

-- ============================================================
-- RPC: renew a registration (anon only)
-- ============================================================

-- result: renewed, not_due (ok = true); invalid_input, unauthorized,
-- disabled, expired, notifications_off, send_paused, token_mismatch,
-- generation_mismatch, os_permission_not_granted, device_check_failed
-- (ok = false). Only renewed and not_due return expires_at.
create function public.renew_push_registration(
  p_registration_id text,
  p_registration_secret text,
  p_push_token text,
  p_token_generation text,
  p_os_permission_granted boolean,
  p_device_check_passed boolean
)
returns table (ok boolean, result text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_now timestamptz;
  v_registration private.push_device_registrations%rowtype;
  v_expires timestamptz;
begin
  -- Sizes first, so oversized input is never hashed or matched.
  if p_registration_id is null or p_registration_secret is null
    or p_push_token is null or p_token_generation is null
    or pg_catalog.octet_length(p_registration_id) <> 36
    or pg_catalog.octet_length(p_registration_secret) <> 64
    or pg_catalog.octet_length(p_push_token) not between 1 and 1024
    or pg_catalog.octet_length(p_token_generation) not between 1 and 10
    or p_registration_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or p_registration_secret !~ '^[0-9a-f]{64}$'
    or p_token_generation !~ '^[1-9][0-9]{0,9}$' then
    return query select false, 'invalid_input'::text, null::timestamptz;
    return;
  end if;

  select d.* into v_registration
  from private.push_device_registrations d
  where d.id = p_registration_id::uuid
  for no key update;

  -- The time once the registration row is held.
  v_now := private.push_registration_current_time();

  if v_registration.id is null
    or private.push_registration_hash(p_registration_secret) is distinct from v_registration.secret_hash then
    return query select false, 'unauthorized'::text, null::timestamptz;
    return;
  end if;

  -- In the U0 order. A disabled registration has no secret, so it is
  -- refused above; checked again here all the same.
  if v_registration.status <> 'active' then
    return query select false, 'disabled'::text, null::timestamptz;
    return;
  end if;

  if v_registration.expires_at <= v_now then
    return query select false, 'expired'::text, null::timestamptz;
    return;
  end if;

  if not v_registration.notifications_enabled then
    return query select false, 'notifications_off'::text, null::timestamptz;
    return;
  end if;

  if v_registration.send_paused then
    return query select false, 'send_paused'::text, null::timestamptz;
    return;
  end if;

  if private.push_registration_hash(p_push_token) is distinct from v_registration.push_token_hash then
    return query select false, 'token_mismatch'::text, null::timestamptz;
    return;
  end if;

  if p_token_generation::bigint <> v_registration.confirmed_token_generation::bigint then
    return query select false, 'generation_mismatch'::text, null::timestamptz;
    return;
  end if;

  if p_os_permission_granted is not true then
    return query select false, 'os_permission_not_granted'::text, null::timestamptz;
    return;
  end if;

  if p_device_check_passed is not true then
    return query select false, 'device_check_failed'::text, null::timestamptz;
    return;
  end if;

  -- Due once at most 45 x 24 hours remain; nothing is written before that.
  if v_registration.expires_at > v_now + interval '1080 hours' then
    return query select true, 'not_due'::text, v_registration.expires_at;
    return;
  end if;

  v_expires := v_now + interval '2160 hours';

  update private.push_device_registrations d
  set expires_at = v_expires
  where d.id = v_registration.id;

  return query select true, 'renewed'::text, v_expires;
end;
$$;

-- ============================================================
-- RPC: disable a registration (anon only)
-- ============================================================

-- result: disabled (ok = true), unauthorized (ok = false). Only disabled
-- confirms the stop: unauthorized is also what a registration that is
-- already disabled returns, as it keeps no secret, so it confirms nothing.
-- An expired registration can be disabled too. Other request rows are not
-- touched (lock order); a pending token_change of this registration is
-- refused when confirmed, once the registration row is found not active.
create function public.disable_push_registration(
  p_registration_id text,
  p_registration_secret text
)
returns table (ok boolean, result text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_now timestamptz;
  v_registration private.push_device_registrations%rowtype;
begin
  -- Sizes first, so oversized input is never hashed or matched.
  if p_registration_id is null or p_registration_secret is null
    or pg_catalog.octet_length(p_registration_id) <> 36
    or pg_catalog.octet_length(p_registration_secret) <> 64
    or p_registration_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or p_registration_secret !~ '^[0-9a-f]{64}$' then
    return query select false, 'unauthorized'::text;
    return;
  end if;

  select d.* into v_registration
  from private.push_device_registrations d
  where d.id = p_registration_id::uuid
  for no key update;

  -- The time once the registration row is held.
  v_now := private.push_registration_current_time();

  if v_registration.id is null or v_registration.status <> 'active'
    or private.push_registration_hash(p_registration_secret) is distinct from v_registration.secret_hash then
    return query select false, 'unauthorized'::text;
    return;
  end if;

  update private.push_device_registrations d
  set status = 'disabled',
      disabled_at = v_now,
      disabled_reason = 'user_disabled',
      push_token = null,
      secret_hash = null
  where d.id = v_registration.id;

  return query select true, 'disabled'::text;
end;
$$;

-- ============================================================
-- RPC: start a token change (service_role only)
-- ============================================================

-- result: created (ok = true: the request exists; it does not by itself
-- allow sending the confirmation push, which needs its own checks, P6
-- included); deferred, rate_limited, conflict, no_change, invalid_input,
-- unauthorized, expired (ok = false). For an authorized token change
-- (created, deferred, rate_limited, conflict) sending is paused and the
-- registration's pending token_change requests are closed; only created
-- adds a request. deferred: confirmation is closed. invalid_input,
-- unauthorized and expired change nothing. no_change: the token is the
-- current one and sending is not paused; a paused registration reporting
-- its current token again still needs a confirmation.
create function public.create_push_token_change_request(
  p_registration_id text,
  p_registration_secret text,
  p_new_push_token text,
  p_request_secret text,
  p_nonce text
)
returns table (ok boolean, result text, request_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_now timestamptz;
  v_registration private.push_device_registrations%rowtype;
  v_token_hash bytea;
  v_id uuid;
begin
  -- Sizes first, so oversized input is never hashed or matched.
  if p_registration_id is null or p_registration_secret is null
    or p_new_push_token is null or p_request_secret is null or p_nonce is null
    or pg_catalog.octet_length(p_registration_id) <> 36
    or pg_catalog.octet_length(p_registration_secret) <> 64
    or pg_catalog.octet_length(p_new_push_token) not between 1 and 1024
    or pg_catalog.octet_length(p_request_secret) <> 43
    or pg_catalog.octet_length(p_nonce) <> 43
    or p_registration_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or p_registration_secret !~ '^[0-9a-f]{64}$'
    or p_request_secret !~ '^[A-Za-z0-9_-]{43}$'
    or p_nonce !~ '^[A-Za-z0-9_-]{43}$'
    or p_request_secret = p_nonce then
    return query select false, 'invalid_input'::text, null::uuid;
    return;
  end if;

  v_token_hash := private.push_registration_hash(p_new_push_token);

  -- Same advisory locks as create_push_registration_request, which (with
  -- this function) is the only way to add a request: while they are held,
  -- no pending request is added.
  perform pg_catalog.pg_advisory_xact_lock(734201, 0);
  perform pg_catalog.pg_advisory_xact_lock(
    734202, pg_catalog.hashtext(pg_catalog.encode(v_token_hash, 'hex'))
  );

  -- The pending requests this call may close, then the registration.
  perform 1
  from private.push_registration_requests r
  where r.state = 'pending'
    and ((r.registration_id = p_registration_id::uuid and r.purpose = 'token_change')
      or r.push_token_hash = v_token_hash)
  order by r.id
  for update;

  select d.* into v_registration
  from private.push_device_registrations d
  where d.id = p_registration_id::uuid
  for no key update;

  -- The time once the locks are held, for every check and write below.
  v_now := private.push_registration_current_time();

  if v_registration.id is null or v_registration.status <> 'active'
    or private.push_registration_hash(p_registration_secret) is distinct from v_registration.secret_hash then
    return query select false, 'unauthorized'::text, null::uuid;
    return;
  end if;

  if v_registration.expires_at <= v_now then
    return query select false, 'expired'::text, null::uuid;
    return;
  end if;

  if v_token_hash = v_registration.push_token_hash and not v_registration.send_paused then
    return query select false, 'no_change'::text, null::uuid;
    return;
  end if;

  -- An authorized token change from here on: whatever follows (deferred,
  -- rate_limited, conflict or created), sending stays paused (B3) and the
  -- registration's pending token_change requests are closed. Done outside
  -- the block below, so its rollback on conflict does not undo it.
  update private.push_registration_requests r
  set state = case when r.expires_at <= v_now then 'expired' else 'cancelled' end,
      closed_at = v_now,
      push_token = null,
      request_secret_hash = null,
      nonce_hash = null
  where r.registration_id = v_registration.id
    and r.purpose = 'token_change'
    and r.state = 'pending';

  update private.push_device_registrations d
  set send_paused = true
  where d.id = v_registration.id
    and not d.send_paused;

  if not private.push_token_change_open() then
    return query select false, 'deferred'::text, null::uuid;
    return;
  end if;

  -- The U1-B limits, counting every request for the new token and overall.
  -- A refused call creates no request (the pause above stays).
  if (select pg_catalog.count(*) from private.push_registration_requests r
      where r.push_token_hash = v_token_hash
        and r.created_at > v_now - interval '1 hour') >= 3
    or (select pg_catalog.count(*) from private.push_registration_requests r
      where r.push_token_hash = v_token_hash
        and r.created_at > v_now - interval '1 day') >= 10
    or (select pg_catalog.count(*) from private.push_registration_requests r
      where r.created_at > v_now - interval '1 minute') >= 60
    or (select pg_catalog.count(*) from private.push_registration_requests r
      where r.created_at > v_now - interval '1 day') >= 2000 then
    return query select false, 'rate_limited'::text, null::uuid;
    return;
  end if;

  -- The newest request replaces the pending ones for the new token (the
  -- registration's own are closed above). Closing them and inserting
  -- succeed or fail together.
  begin
    update private.push_registration_requests r
    set state = case when r.expires_at <= v_now then 'expired' else 'cancelled' end,
        closed_at = v_now,
        push_token = null,
        request_secret_hash = null,
        nonce_hash = null
    where r.state = 'pending'
      and ((r.registration_id = v_registration.id and r.purpose = 'token_change')
        or r.push_token_hash = v_token_hash);

    insert into private.push_registration_requests
      (purpose, registration_id, push_token, push_token_hash, request_secret_hash, nonce_hash,
       state, created_at, expires_at)
    values
      ('token_change', v_registration.id, p_new_push_token, v_token_hash,
       private.push_registration_hash(p_request_secret),
       private.push_registration_hash(p_nonce),
       'pending', v_now, v_now + interval '10 minutes')
    returning id into v_id;
  exception
    when unique_violation then
      return query select false, 'conflict'::text, null::uuid;
      return;
  end;

  -- Close up to 20 expired pending requests, skipping rows another
  -- transaction holds.
  update private.push_registration_requests r
  set state = 'expired',
      closed_at = v_now,
      push_token = null,
      request_secret_hash = null,
      nonce_hash = null
  where r.id in (
    select c.id
    from private.push_registration_requests c
    where c.state = 'pending'
      and c.expires_at <= v_now
    order by c.expires_at
    limit 20
    for update skip locked
  );

  return query select true, 'created'::text, v_id;
end;
$$;

-- ============================================================
-- RPC: confirm a token change (anon only)
-- ============================================================

-- Every failure returns the same row (ok = false, other columns null).
create function public.confirm_push_token_change(
  p_request_id text,
  p_registration_secret text,
  p_request_secret text,
  p_nonce text
)
returns table (ok boolean, confirmed_token_generation integer, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_now timestamptz;
  v_request private.push_registration_requests%rowtype;
  v_registration private.push_device_registrations%rowtype;
  v_locked uuid[];
  v_generation integer;
begin
  -- Sizes first, so oversized input is never hashed or matched.
  if p_request_id is null or p_registration_secret is null
    or p_request_secret is null or p_nonce is null
    or pg_catalog.octet_length(p_request_id) <> 36
    or pg_catalog.octet_length(p_registration_secret) <> 64
    or pg_catalog.octet_length(p_request_secret) <> 43
    or pg_catalog.octet_length(p_nonce) <> 43
    or p_request_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or p_registration_secret !~ '^[0-9a-f]{64}$'
    or p_request_secret !~ '^[A-Za-z0-9_-]{43}$'
    or p_nonce !~ '^[A-Za-z0-9_-]{43}$' then
    return query select false, null::integer, null::timestamptz;
    return;
  end if;

  if not private.push_token_change_open() then
    return query select false, null::integer, null::timestamptz;
    return;
  end if;

  select r.* into v_request
  from private.push_registration_requests r
  where r.id = p_request_id::uuid
  for update;

  -- The time once the request row is held, for its checks and writes.
  v_now := private.push_registration_current_time();

  if v_request.id is null or v_request.purpose <> 'token_change' or v_request.state <> 'pending' then
    return query select false, null::integer, null::timestamptz;
    return;
  end if;

  if v_request.expires_at <= v_now then
    update private.push_registration_requests r
    set state = 'expired', closed_at = v_now,
        push_token = null, request_secret_hash = null, nonce_hash = null
    where r.id = v_request.id;
    return query select false, null::integer, null::timestamptz;
    return;
  end if;

  if private.push_registration_hash(p_request_secret) <> v_request.request_secret_hash
    or private.push_registration_hash(p_nonce) <> v_request.nonce_hash then
    -- Counted and committed (no exception); the fifth failure closes it.
    update private.push_registration_requests r
    set failed_attempts = r.failed_attempts + 1,
        state = case when r.failed_attempts + 1 >= 5 then 'cancelled' else r.state end,
        closed_at = case when r.failed_attempts + 1 >= 5 then v_now else r.closed_at end,
        push_token = case when r.failed_attempts + 1 >= 5 then null else r.push_token end,
        request_secret_hash = case when r.failed_attempts + 1 >= 5 then null else r.request_secret_hash end,
        nonce_hash = case when r.failed_attempts + 1 >= 5 then null else r.nonce_hash end
    where r.id = v_request.id;
    return query select false, null::integer, null::timestamptz;
    return;
  end if;

  -- Checked again right before confirming.
  if not private.push_token_change_open() then
    return query select false, null::integer, null::timestamptz;
    return;
  end if;

  -- The registration and the active registrations with the new token, in
  -- one statement in id order, so two changes to each other's tokens lock
  -- in the same order. A row that stopped matching while this waited is
  -- skipped, so everything is checked again below.
  select pg_catalog.array_agg(l.id) into v_locked
  from (
    select d.id
    from private.push_device_registrations d
    where d.id = v_request.registration_id
      or (d.push_token_hash = v_request.push_token_hash and d.status = 'active')
    order by d.id
    for no key update
  ) l;

  -- The time again once the registration rows are held.
  v_now := private.push_registration_current_time();

  if v_request.expires_at <= v_now then
    update private.push_registration_requests r
    set state = 'expired', closed_at = v_now,
        push_token = null, request_secret_hash = null, nonce_hash = null
    where r.id = v_request.id;
    return query select false, null::integer, null::timestamptz;
    return;
  end if;

  select d.* into v_registration
  from private.push_device_registrations d
  where d.id = v_request.registration_id;

  -- Active, not expired, paused for this change and the secret matches;
  -- otherwise the request is cancelled and the registration left as it is.
  if v_registration.id is null or v_registration.status <> 'active'
    or v_registration.expires_at <= v_now
    or not v_registration.send_paused
    or private.push_registration_hash(p_registration_secret) is distinct from v_registration.secret_hash then
    update private.push_registration_requests r
    set state = 'cancelled', closed_at = v_now,
        push_token = null, request_secret_hash = null, nonce_hash = null
    where r.id = v_request.id;
    return query select false, null::integer, null::timestamptz;
    return;
  end if;

  -- Every other active registration with the new token must be one locked
  -- above; if not, nothing changes.
  if exists (
    select 1
    from private.push_device_registrations d
    where d.push_token_hash = v_request.push_token_hash
      and d.status = 'active'
      and d.id <> v_registration.id
      and not (d.id = any (v_locked))
  ) then
    return query select false, null::integer, null::timestamptz;
    return;
  end if;

  update private.push_device_registrations d
  set status = 'disabled',
      disabled_at = v_now,
      disabled_reason = 'replaced_by_token_change',
      push_token = null,
      secret_hash = null
  where d.push_token_hash = v_request.push_token_hash
    and d.status = 'active'
    and d.id <> v_registration.id
    and d.id = any (v_locked);

  -- Resume on the new token with the next generation; the expiry stays.
  update private.push_device_registrations d
  set push_token = v_request.push_token,
      push_token_hash = v_request.push_token_hash,
      confirmed_token_generation = d.confirmed_token_generation + 1,
      send_paused = false
  where d.id = v_registration.id
  returning d.confirmed_token_generation into v_generation;

  update private.push_registration_requests r
  set state = 'consumed', closed_at = v_now,
      push_token = null, request_secret_hash = null, nonce_hash = null
  where r.id = v_request.id;

  return query select true, v_generation, v_registration.expires_at;
end;
$$;

-- ============================================================
-- Grants
-- ============================================================

revoke all on function public.renew_push_registration(text, text, text, text, boolean, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.renew_push_registration(text, text, text, text, boolean, boolean)
  to anon;

revoke all on function public.disable_push_registration(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.disable_push_registration(text, text)
  to anon;

revoke all on function public.create_push_token_change_request(text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_push_token_change_request(text, text, text, text, text)
  to service_role;

revoke all on function public.confirm_push_token_change(text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.confirm_push_token_change(text, text, text, text)
  to anon;
