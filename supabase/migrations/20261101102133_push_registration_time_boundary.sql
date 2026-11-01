-- Time boundary for the push registration RPCs (roadmap 3, before U1-C).
--
-- The U1-B RPCs took v_now from now(), the transaction start, before
-- waiting for their locks, so a request that expired while
-- confirm_push_registration waited for its row could still be accepted.
-- Both RPCs now take the time from private.push_registration_current_time()
-- once their locks are held, and use that value for every check and write,
-- including the created_at of the rows they insert (the rate limits count
-- requests by created_at, so it must be the time the limits were checked);
-- confirm_push_registration takes it again after locking the registration
-- rows and refuses a request that expired meanwhile. Nothing else changes:
-- names, arguments, results, limits, lock order, intake (still closed) and
-- grants are the same.
--
-- private.push_registration_current_time() returns clock_timestamp(). It
-- exists so tests can fix the time inside a rolled-back transaction.

-- ============================================================
-- Helper (not callable by clients)
-- ============================================================

create function private.push_registration_current_time()
returns timestamptz
language sql
volatile
set search_path = ''
as $$ select pg_catalog.clock_timestamp() $$;

revoke all on function private.push_registration_current_time()
  from public, anon, authenticated, service_role;

-- ============================================================
-- RPC: create a pending request (service_role only)
-- ============================================================

-- result: created, invalid_input, intake_closed, rate_limited, conflict.
create or replace function public.create_push_registration_request(
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
  v_now timestamptz;
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

  -- The time for every check and write below, taken once the locks are
  -- held (now() is the transaction start, before any lock wait).
  v_now := private.push_registration_current_time();

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
      (purpose, push_token, push_token_hash, request_secret_hash, nonce_hash, state, created_at, expires_at)
    values
      ('new', p_push_token, v_token_hash,
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
-- RPC: confirm a request and activate a registration (anon only)
-- ============================================================

-- Every failure returns the same row (ok = false, other columns null).
create or replace function public.confirm_push_registration(
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
  v_now timestamptz;
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

  -- The time once the request row is held, for its checks and writes.
  v_now := private.push_registration_current_time();

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

  -- The time again once the registration rows are held: a request that
  -- expired while waiting activates nothing and disables nothing.
  v_now := private.push_registration_current_time();

  if v_request.expires_at <= v_now then
    update private.push_registration_requests r
    set state = 'expired', closed_at = v_now,
        push_token = null, request_secret_hash = null, nonce_hash = null
    where r.id = v_request.id;
    return query select false, null::uuid, null::text, null::timestamptz;
    return;
  end if;

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
     send_paused, notifications_enabled, created_at, updated_at, expires_at)
  values
    ('active', v_request.push_token, v_request.push_token_hash,
     private.push_registration_hash(v_secret), 1, false, true, v_now, v_now, v_expires)
  returning id into v_id;

  update private.push_registration_requests r
  set state = 'consumed', closed_at = v_now,
      push_token = null, request_secret_hash = null, nonce_hash = null
  where r.id = v_request.id;

  return query select true, v_id, v_secret, v_expires;
end;
$$;

-- ============================================================
-- Grants (unchanged; restated for the replaced functions)
-- ============================================================

revoke all on function public.create_push_registration_request(text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_push_registration_request(text, text, text)
  to service_role;

revoke all on function public.confirm_push_registration(text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.confirm_push_registration(text, text, text)
  to anon;
