-- Push registration request and confirmation RPCs (roadmap 3, U1-B).
--
-- public.create_push_registration_request (service_role only) records a
-- pending request for a push token. The caller (a later Edge Function)
-- generates the request secret, returned to the app over HTTP, and the
-- nonce, sent only in the confirmation push; both are 32 random bytes in
-- base64url (43 characters) and only their SHA-256 hashes are stored.
--
-- public.confirm_push_registration (anon only) activates a registration
-- only when both the request secret and the nonce match. A mismatch is a
-- normal result, not an exception, so the counted attempt is committed.
-- The registration secret is generated here, returned once and stored only
-- as a hash. Any active registration with the same token is disabled.
--
-- Both refuse while private.push_registration_intake_open() is false, which
-- is all it ever returns here: intake opens only through a later, approved
-- migration that replaces it with the usage-monitoring check (P6). There is
-- no setting or table to open it.
--
-- Lock order: global advisory lock, then per-token advisory lock, then
-- push_registration_requests rows, then push_device_registrations rows.
-- confirm_push_registration touches no request row other than its own; a
-- token_change request of a registration disabled here stays pending until
-- it expires, and its later confirmation (U1-C) must refuse once the
-- registration row is locked and found not active.
--
-- Secrets, nonces and tokens never appear in results or error messages, and
-- invalid input is a result too, so the arguments are not logged with an
-- error.

-- ============================================================
-- Helpers (not callable by clients)
-- ============================================================

-- Closed. Opening intake needs a new migration with the P6 check.
create function private.push_registration_intake_open()
returns boolean
language sql
stable
set search_path = ''
as $$ select false $$;

create function private.push_registration_hash(p_value text)
returns bytea
language sql
immutable
strict
set search_path = ''
as $$ select pg_catalog.sha256(pg_catalog.convert_to(p_value, 'UTF8')) $$;

revoke all on function private.push_registration_intake_open()
  from public, anon, authenticated, service_role;
revoke all on function private.push_registration_hash(text)
  from public, anon, authenticated, service_role;

-- ============================================================
-- RPC: create a pending request (service_role only)
-- ============================================================

-- result: created, invalid_input, intake_closed, rate_limited, conflict.
create function public.create_push_registration_request(
  p_push_token text,
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
  v_now timestamptz := pg_catalog.now();
  v_token_hash bytea;
  v_id uuid;
begin
  -- Sizes first, so oversized input is never hashed or matched.
  if p_push_token is null or p_request_secret is null or p_nonce is null
    or pg_catalog.octet_length(p_push_token) not between 1 and 1024
    or pg_catalog.octet_length(p_request_secret) <> 43
    or pg_catalog.octet_length(p_nonce) <> 43
    or p_request_secret !~ '^[A-Za-z0-9_-]{43}$'
    or p_nonce !~ '^[A-Za-z0-9_-]{43}$'
    or p_request_secret = p_nonce then
    return query select false, 'invalid_input'::text, null::uuid;
    return;
  end if;

  if not private.push_registration_intake_open() then
    return query select false, 'intake_closed'::text, null::uuid;
    return;
  end if;

  v_token_hash := private.push_registration_hash(p_push_token);

  -- Serialize requests overall (global limits) and per token (a row that
  -- does not exist yet cannot be locked with FOR UPDATE).
  perform pg_catalog.pg_advisory_xact_lock(734201, 0);
  perform pg_catalog.pg_advisory_xact_lock(
    734202, pg_catalog.hashtext(pg_catalog.encode(v_token_hash, 'hex'))
  );

  -- Every request created counts, whatever its state now. Checked before
  -- anything changes, so a refused call cancels nothing.
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

  -- The newest request for a token replaces a pending one. Closing it and
  -- inserting succeed or fail together.
  begin
    update private.push_registration_requests r
    set state = case when r.expires_at <= v_now then 'expired' else 'cancelled' end,
        closed_at = v_now,
        push_token = null,
        request_secret_hash = null,
        nonce_hash = null
    where r.push_token_hash = v_token_hash
      and r.state = 'pending';

    insert into private.push_registration_requests
      (purpose, push_token, push_token_hash, request_secret_hash, nonce_hash, state, expires_at)
    values
      ('new', p_push_token, v_token_hash,
       private.push_registration_hash(p_request_secret),
       private.push_registration_hash(p_nonce),
       'pending', v_now + interval '10 minutes')
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
-- RPC: confirm a request and activate a registration (anon only)
-- ============================================================

-- Every failure returns the same row (ok = false, other columns null).
create function public.confirm_push_registration(
  p_request_id text,
  p_request_secret text,
  p_nonce text
)
returns table (ok boolean, registration_id uuid, registration_secret text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_now timestamptz := pg_catalog.now();
  v_request private.push_registration_requests%rowtype;
  v_secret text;
  v_id uuid;
  v_expires timestamptz;
begin
  -- Sizes first, so oversized input is never hashed or matched.
  if p_request_id is null or p_request_secret is null or p_nonce is null
    or pg_catalog.octet_length(p_request_id) <> 36
    or pg_catalog.octet_length(p_request_secret) <> 43
    or pg_catalog.octet_length(p_nonce) <> 43
    or p_request_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or p_request_secret !~ '^[A-Za-z0-9_-]{43}$'
    or p_nonce !~ '^[A-Za-z0-9_-]{43}$' then
    return query select false, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  if not private.push_registration_intake_open() then
    return query select false, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  select r.* into v_request
  from private.push_registration_requests r
  where r.id = p_request_id::uuid
  for update;

  if not found or v_request.purpose <> 'new' or v_request.state <> 'pending' then
    return query select false, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  if v_request.expires_at <= v_now then
    update private.push_registration_requests r
    set state = 'expired', closed_at = v_now,
        push_token = null, request_secret_hash = null, nonce_hash = null
    where r.id = v_request.id;
    return query select false, null::uuid, null::text, null::timestamptz;
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
    return query select false, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  -- Checked again right before activating.
  if not private.push_registration_intake_open() then
    return query select false, null::uuid, null::text, null::timestamptz;
    return;
  end if;

  perform 1
  from private.push_device_registrations d
  where d.push_token_hash = v_request.push_token_hash
    and d.status = 'active'
  for no key update;

  update private.push_device_registrations d
  set status = 'disabled',
      disabled_at = v_now,
      disabled_reason = 'replaced_by_new_registration',
      push_token = null,
      secret_hash = null
  where d.push_token_hash = v_request.push_token_hash
    and d.status = 'active';

  v_secret := pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')
    || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');
  v_expires := v_now + interval '2160 hours';

  insert into private.push_device_registrations
    (status, push_token, push_token_hash, secret_hash, confirmed_token_generation,
     send_paused, notifications_enabled, expires_at)
  values
    ('active', v_request.push_token, v_request.push_token_hash,
     private.push_registration_hash(v_secret), 1, false, true, v_expires)
  returning id into v_id;

  update private.push_registration_requests r
  set state = 'consumed', closed_at = v_now,
      push_token = null, request_secret_hash = null, nonce_hash = null
  where r.id = v_request.id;

  return query select true, v_id, v_secret, v_expires;
end;
$$;

-- ============================================================
-- Grants
-- ============================================================

revoke all on function public.create_push_registration_request(text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_push_registration_request(text, text, text)
  to service_role;

revoke all on function public.confirm_push_registration(text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.confirm_push_registration(text, text, text)
  to anon;
