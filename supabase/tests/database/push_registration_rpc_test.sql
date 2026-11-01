-- pgTAP tests for the push registration RPCs (roadmap 3, U1-B).
-- Everything runs inside one transaction and is rolled back, including the
-- temporary replacement of private.push_registration_intake_open() used to
-- test the open path; the migration's version (always false) is checked
-- first and restored at the end. Tokens and secrets are dummy values. One
-- transaction cannot test real concurrency, and a counted failure is only
-- shown to be written, not committed by a separate client.

begin;

create extension if not exists pgtap with schema extensions;

select plan(89);

-- ============================================================
-- Structure, grants and intake (state right after the migration)
-- ============================================================

select has_function('public', 'create_push_registration_request', array['text', 'text', 'text'], 'create_push_registration_request(text, text, text) exists');
select has_function('public', 'confirm_push_registration', array['text', 'text', 'text'], 'confirm_push_registration(text, text, text) exists');
select ok((select bool_and(prosecdef and proconfig @> array['search_path=""']) from pg_proc where oid in ('public.create_push_registration_request(text, text, text)'::regprocedure, 'public.confirm_push_registration(text, text, text)'::regprocedure)), 'both RPCs are SECURITY DEFINER with empty search_path');
select ok((select bool_and(not prosecdef and proconfig @> array['search_path=""']) from pg_proc where oid in ('private.push_registration_intake_open()'::regprocedure, 'private.push_registration_hash(text)'::regprocedure)), 'helpers are SECURITY INVOKER with empty search_path');
select ok(has_function_privilege('service_role', 'public.create_push_registration_request(text, text, text)', 'execute') and not (select bool_or(has_function_privilege(r, 'public.create_push_registration_request(text, text, text)', 'execute')) from unnest(array['public','anon','authenticated']) r), 'create_push_registration_request: service_role only');
select ok(has_function_privilege('anon', 'public.confirm_push_registration(text, text, text)', 'execute') and not (select bool_or(has_function_privilege(r, 'public.confirm_push_registration(text, text, text)', 'execute')) from unnest(array['public','authenticated','service_role']) r), 'confirm_push_registration: anon only');
select ok(not (select bool_or(has_function_privilege(r, f, 'execute')) from unnest(array['public','anon','authenticated','service_role']) r, unnest(array['private.push_registration_intake_open()','private.push_registration_hash(text)']) f), 'helpers are not executable by client roles');
select ok((select provolatile = 'v' and not prosecdef and proconfig @> array['search_path=""'] and btrim(prosrc) = 'select pg_catalog.clock_timestamp()' from pg_proc where oid = 'private.push_registration_current_time()'::regprocedure), 'the time helper returns clock_timestamp(), volatile, SECURITY INVOKER, empty search_path');
select ok(not (select bool_or(has_function_privilege(r, 'private.push_registration_current_time()', 'execute')) from unnest(array['public','anon','authenticated','service_role']) r), 'the time helper is not executable by client roles');
select is(
  (select coalesce(array_agg(s.sig order by s.sig collate "C"), '{}')
   from (select n.nspname || '.' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' as sig
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')) s),
  array['public.confirm_push_registration(text, text, text)'],
  'the only public function anon can execute is confirm_push_registration'
);
select ok(has_function_privilege('authenticated', 'public.current_user_is_admin()', 'execute') and has_function_privilege('authenticated', 'public.update_sale_event(uuid, timestamptz, boolean, text, text, timestamptz, timestamptz, boolean, text, timestamptz)', 'execute') and not has_function_privilege('anon', 'public.update_sale_event(uuid, timestamptz, boolean, text, text, timestamptz, timestamptz, boolean, text, timestamptz)', 'execute'), 'existing RPC grants are unchanged');
select is(pg_catalog.pg_get_function_result('public.create_push_registration_request(text, text, text)'::regprocedure), 'TABLE(ok boolean, result text, request_id uuid)', 'create_push_registration_request returns (ok, result, request_id)');
select is(pg_catalog.pg_get_function_result('public.confirm_push_registration(text, text, text)'::regprocedure), 'TABLE(ok boolean, registration_id uuid, registration_secret text, expires_at timestamp with time zone)', 'confirm_push_registration returns (ok, registration_id, registration_secret, expires_at)');
select ok(not private.push_registration_intake_open(), 'intake is closed after the migration');
select is((select btrim(prosrc) from pg_proc where oid = 'private.push_registration_intake_open()'::regprocedure), 'select false', 'the migration''s intake function only returns false');

-- ============================================================
-- Intake closed: nothing is created or activated
-- ============================================================

insert into private.push_registration_requests
  (id, purpose, push_token, push_token_hash, request_secret_hash, nonce_hash, state, expires_at)
values
  ('42000000-0000-4000-8000-000000000001', 'new', 'test-token-r0', private.push_registration_hash('test-token-r0'),
   private.push_registration_hash(repeat('E', 43)), private.push_registration_hash(repeat('F', 43)), 'pending', now() + interval '10 minutes');

select is((select result from public.create_push_registration_request('test-token-closed', repeat('A', 43), repeat('B', 43))), 'intake_closed', 'closed intake: request refused');
select is((select count(*)::int from private.push_registration_requests where push_token_hash = private.push_registration_hash('test-token-closed')), 0, 'closed intake: no request row');
select is((select ok from public.confirm_push_registration('42000000-0000-4000-8000-000000000001', repeat('E', 43), repeat('F', 43))), false, 'closed intake: confirmation refused even with matching values');
select is((select state || ':' || failed_attempts::text from private.push_registration_requests where id = '42000000-0000-4000-8000-000000000001'), 'pending:0', 'closed intake: the request is untouched and nothing is counted');

-- Open intake for the rest of this transaction only (rolled back).
create or replace function private.push_registration_intake_open()
returns boolean language sql stable set search_path = '' as $$ select true $$;

-- Fix the RPCs' time to now() (the transaction start) so expectations below
-- are exact; the time-boundary tests move it. Rolled back with the rest.
create or replace function private.push_registration_current_time()
returns timestamptz language sql volatile set search_path = '' as $$ select pg_catalog.now() $$;

-- ============================================================
-- create_push_registration_request: input
-- ============================================================

select is((select result from public.create_push_registration_request('', repeat('A', 43), repeat('B', 43))), 'invalid_input', 'empty token is invalid');
select is((select result from public.create_push_registration_request(repeat('a', 1025), repeat('A', 43), repeat('B', 43))), 'invalid_input', 'token of 1025 bytes is invalid');
select is((select result from public.create_push_registration_request('test-token-i1', repeat('A', 42), repeat('B', 43))), 'invalid_input', 'request secret of 42 characters is invalid');
select is((select result from public.create_push_registration_request('test-token-i1', repeat('A', 43), repeat('B', 42) || '!')), 'invalid_input', 'nonce outside base64url is invalid');
select is((select result from public.create_push_registration_request('test-token-i1', repeat('A', 43), repeat('A', 43))), 'invalid_input', 'request secret equal to the nonce is invalid');
select is((select result from public.create_push_registration_request(null, repeat('A', 43), repeat('B', 43))), 'invalid_input', 'null token is invalid');
select is((select result from public.create_push_registration_request(repeat('a', 100000), repeat('A', 43), repeat('B', 43))), 'invalid_input', 'oversized token is invalid');
select is((select count(*)::int from private.push_registration_requests), 1, 'invalid input creates no request row');

-- ============================================================
-- create_push_registration_request: normal requests
-- ============================================================

select is((select result from public.create_push_registration_request('test-token-n1', repeat('A', 43), repeat('B', 43))), 'created', 'a valid request is created');
select ok((select purpose = 'new' and state = 'pending' and push_token = 'test-token-n1'
             and push_token_hash = private.push_registration_hash('test-token-n1')
             and request_secret_hash = private.push_registration_hash(repeat('A', 43))
             and nonce_hash = private.push_registration_hash(repeat('B', 43))
             and octet_length(request_secret_hash) = 32
             and expires_at = now() + interval '10 minutes' and failed_attempts = 0 and closed_at is null
           from private.push_registration_requests where push_token_hash = private.push_registration_hash('test-token-n1')),
          'the request stores only SHA-256 hashes of the secret and nonce, and expires after 10 minutes');
select is((select result from public.create_push_registration_request('test-token-n1', repeat('C', 43), repeat('D', 43))), 'created', 'a second request for the same token is created');
select ok((select count(*) filter (where state = 'pending') = 1
             and count(*) filter (where state = 'cancelled' and push_token is null and request_secret_hash is null and nonce_hash is null and closed_at = now()) = 1
           from private.push_registration_requests where push_token_hash = private.push_registration_hash('test-token-n1')),
          'the earlier pending request is cancelled with its secrets removed');

insert into private.push_registration_requests
  (id, purpose, push_token, push_token_hash, request_secret_hash, nonce_hash, state, created_at, expires_at)
values
  ('42000000-0000-4000-8000-000000000002', 'new', 'test-token-e1', private.push_registration_hash('test-token-e1'),
   private.push_registration_hash(repeat('E', 43)), private.push_registration_hash(repeat('F', 43)), 'pending',
   now() - interval '20 minutes', now() - interval '10 minutes');

select is((select result from public.create_push_registration_request('test-token-e1', repeat('A', 43), repeat('B', 43))), 'created', 'a request replaces an expired pending one');
select ok((select state = 'expired' and push_token is null and request_secret_hash is null and nonce_hash is null
           from private.push_registration_requests where id = '42000000-0000-4000-8000-000000000002'),
          'the expired pending request is closed as expired');

-- ============================================================
-- create_push_registration_request: per-token limits
-- ============================================================

insert into private.push_registration_requests (purpose, push_token_hash, state, created_at, expires_at, closed_at)
select 'new', private.push_registration_hash('test-token-h1'), 'cancelled', now() - interval '30 minutes', now() - interval '20 minutes', now() - interval '25 minutes'
from generate_series(1, 2);
insert into private.push_registration_requests
  (id, purpose, push_token, push_token_hash, request_secret_hash, nonce_hash, state, created_at, expires_at)
values
  ('42000000-0000-4000-8000-000000000003', 'new', 'test-token-h1', private.push_registration_hash('test-token-h1'),
   private.push_registration_hash(repeat('E', 43)), private.push_registration_hash(repeat('F', 43)), 'pending',
   now() - interval '1 minute', now() + interval '9 minutes');

select is((select result from public.create_push_registration_request('test-token-h1', repeat('A', 43), repeat('B', 43))), 'rate_limited', 'a fourth request for a token within an hour is refused');
select ok((select state = 'pending' and request_secret_hash is not null and nonce_hash is not null
           from private.push_registration_requests where id = '42000000-0000-4000-8000-000000000003'),
          'a refused request cancels nothing');

insert into private.push_registration_requests (purpose, push_token_hash, state, created_at, expires_at, closed_at)
select 'new', private.push_registration_hash('test-token-d1'), 'expired', now() - interval '5 hours', now() - interval '290 minutes', now() - interval '290 minutes'
from generate_series(1, 10);
insert into private.push_registration_requests (purpose, push_token_hash, state, created_at, expires_at, closed_at)
select 'new', private.push_registration_hash('test-token-d2'), 'expired', now() - interval '5 hours', now() - interval '290 minutes', now() - interval '290 minutes'
from generate_series(1, 9);

select is((select result from public.create_push_registration_request('test-token-d1', repeat('A', 43), repeat('B', 43))), 'rate_limited', 'an eleventh request for a token within a day is refused');
select is((select result from public.create_push_registration_request('test-token-d2', repeat('A', 43), repeat('B', 43))), 'created', 'a tenth request for a token within a day is created');

-- ============================================================
-- create_push_registration_request: closing expired requests
-- ============================================================

insert into private.push_registration_requests
  (purpose, push_token, push_token_hash, request_secret_hash, nonce_hash, state, created_at, expires_at)
select 'new', 'test-token-x' || i, private.push_registration_hash('test-token-x' || i),
       private.push_registration_hash(repeat('E', 43)), private.push_registration_hash(repeat('F', 43)), 'pending',
       now() - interval '20 minutes', now() - interval '10 minutes'
from generate_series(1, 25) i;

select is((select result from public.create_push_registration_request('test-token-c1', repeat('A', 43), repeat('B', 43))), 'created', 'a request is created while expired requests wait');
select is((select count(*)::int from private.push_registration_requests where push_token like 'test-token-x%' and state = 'pending'), 5, 'at most 20 expired requests are closed per call');
select is((select count(*)::int from private.push_registration_requests r
           where r.push_token_hash in (select private.push_registration_hash('test-token-x' || i) from generate_series(1, 25) i)
             and r.state = 'expired' and r.push_token is null and r.request_secret_hash is null and r.nonce_hash is null),
          20, 'closed expired requests keep no token or secret');

-- ============================================================
-- confirm_push_registration
-- ============================================================

insert into private.push_device_registrations
  (id, status, push_token, push_token_hash, secret_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at)
values
  ('43000000-0000-4000-8000-000000000001', 'active', 'test-token-q1', private.push_registration_hash('test-token-q1'),
   '\xb1', 1, false, true, now() + interval '30 days');

insert into private.push_registration_requests
  (id, purpose, registration_id, push_token, push_token_hash, request_secret_hash, nonce_hash, state, expires_at)
values
  ('42000000-0000-4000-8000-000000000011', 'new', null, 'test-token-q1', private.push_registration_hash('test-token-q1'),
   private.push_registration_hash(repeat('E', 43)), private.push_registration_hash(repeat('F', 43)), 'pending', now() + interval '10 minutes'),
  ('42000000-0000-4000-8000-000000000012', 'token_change', '43000000-0000-4000-8000-000000000001', 'test-token-q1b', private.push_registration_hash('test-token-q1b'),
   private.push_registration_hash(repeat('E', 43)), private.push_registration_hash(repeat('F', 43)), 'pending', now() + interval '10 minutes');

select is((select ok from public.confirm_push_registration('42000000-0000-4000-8000-000000000011', repeat('X', 43), repeat('F', 43))), false, 'a wrong request secret is refused');
select is((select state || ':' || failed_attempts::text from private.push_registration_requests where id = '42000000-0000-4000-8000-000000000011'), 'pending:1', 'the failed attempt is counted without an exception');
select is((select ok from public.confirm_push_registration('42000000-0000-4000-8000-000000000011', repeat('E', 43), repeat('X', 43))), false, 'a wrong nonce is refused');
select is((select ok from public.confirm_push_registration('42000000-0000-4000-8000-000000000011', repeat('X', 43), repeat('Y', 43))), false, 'a wrong secret and nonce are refused');
select is((select failed_attempts from private.push_registration_requests where id = '42000000-0000-4000-8000-000000000011'), 3, 'each mismatch is counted');
select is((select ok from public.confirm_push_registration('42000000-0000-4000-8000-00000000001', repeat('E', 43), repeat('F', 43))), false, 'a malformed request id is refused');
select is((select ok from public.confirm_push_registration('42000000-0000-4000-8000-000000000011', repeat('E', 100000), repeat('F', 43))), false, 'an oversized request secret is refused');
select is((select ok from public.confirm_push_registration('42000000-0000-4000-8000-000000000011', repeat('E', 43), null)), false, 'a null nonce is refused');
select is((select failed_attempts from private.push_registration_requests where id = '42000000-0000-4000-8000-000000000011'), 3, 'invalid input is not counted as an attempt');
select is((select ok from public.confirm_push_registration('42000000-0000-4000-8000-0000000000ff', repeat('E', 43), repeat('F', 43))), false, 'an unknown request id is refused');

-- Called once; its result is checked in the next statement, which can see
-- the registration row the call inserted.
create temp table u1b_confirmed on commit drop as
select * from public.confirm_push_registration('42000000-0000-4000-8000-000000000011', repeat('E', 43), repeat('F', 43));

select ok((select c.ok and c.registration_secret ~ '^[0-9a-f]{64}$'
             and d.secret_hash = private.push_registration_hash(c.registration_secret) and octet_length(d.secret_hash) = 32
             and c.expires_at = now() + interval '2160 hours' and d.expires_at = c.expires_at
             and d.status = 'active' and d.confirmed_token_generation = 1 and not d.send_paused and d.notifications_enabled
             and d.push_token = 'test-token-q1' and d.push_token_hash = private.push_registration_hash('test-token-q1')
           from u1b_confirmed c
           join private.push_device_registrations d on d.id = c.registration_id),
          'matching secret and nonce activate a registration whose secret is returned once and stored as a hash, for 90 x 24 hours');
select ok((select status = 'disabled' and disabled_reason = 'replaced_by_new_registration' and disabled_at = now()
             and push_token is null and secret_hash is null
           from private.push_device_registrations where id = '43000000-0000-4000-8000-000000000001'),
          'the older active registration for the token is disabled without its token and secret');
select ok((select state = 'consumed' and closed_at = now() and push_token is null and request_secret_hash is null and nonce_hash is null
           from private.push_registration_requests where id = '42000000-0000-4000-8000-000000000011'),
          'the confirmed request is consumed with its secrets removed');
select ok((select state = 'pending' and request_secret_hash is not null and failed_attempts = 0
           from private.push_registration_requests where id = '42000000-0000-4000-8000-000000000012'),
          'other requests (the old registration''s token_change) are not touched');
select is((select ok from public.confirm_push_registration('42000000-0000-4000-8000-000000000011', repeat('E', 43), repeat('F', 43))), false, 'a consumed request cannot be confirmed again');
select is((select count(*)::int from private.push_device_registrations where push_token_hash = private.push_registration_hash('test-token-q1') and status = 'active'), 1, 'one active registration for the token');

-- Five failures close a request.
insert into private.push_registration_requests
  (id, purpose, push_token, push_token_hash, request_secret_hash, nonce_hash, state, expires_at)
values
  ('42000000-0000-4000-8000-000000000021', 'new', 'test-token-q2', private.push_registration_hash('test-token-q2'),
   private.push_registration_hash(repeat('E', 43)), private.push_registration_hash(repeat('F', 43)), 'pending', now() + interval '10 minutes');

select is((select count(*)::int from generate_series(1, 4) g
           cross join lateral public.confirm_push_registration('42000000-0000-4000-8000-000000000021', left(repeat('X', 43) || g::text, 43), repeat('F', 43)) c
           where not c.ok), 4, 'four mismatches are refused');
select is((select state || ':' || failed_attempts::text from private.push_registration_requests where id = '42000000-0000-4000-8000-000000000021'), 'pending:4', 'four failures keep the request pending');
select is((select ok from public.confirm_push_registration('42000000-0000-4000-8000-000000000021', repeat('X', 43), repeat('F', 43))), false, 'the fifth mismatch is refused');
select ok((select state = 'cancelled' and failed_attempts = 5 and closed_at = now()
             and push_token is null and request_secret_hash is null and nonce_hash is null
           from private.push_registration_requests where id = '42000000-0000-4000-8000-000000000021'),
          'the fifth failure cancels the request and removes its secrets');
select is((select ok from public.confirm_push_registration('42000000-0000-4000-8000-000000000021', repeat('E', 43), repeat('F', 43))), false, 'a cancelled request cannot be confirmed even with matching values');

-- Expiry boundary (expires_at is exclusive).
insert into private.push_registration_requests
  (id, purpose, push_token, push_token_hash, request_secret_hash, nonce_hash, state, created_at, expires_at)
values
  ('42000000-0000-4000-8000-000000000031', 'new', 'test-token-q3', private.push_registration_hash('test-token-q3'),
   private.push_registration_hash(repeat('E', 43)), private.push_registration_hash(repeat('F', 43)), 'pending',
   now() - interval '10 minutes', now()),
  ('42000000-0000-4000-8000-000000000041', 'new', 'test-token-q4', private.push_registration_hash('test-token-q4'),
   private.push_registration_hash(repeat('E', 43)), private.push_registration_hash(repeat('F', 43)), 'pending',
   now() - interval '10 minutes', now() + interval '1 microsecond');

select is((select ok from public.confirm_push_registration('42000000-0000-4000-8000-000000000031', repeat('E', 43), repeat('F', 43))), false, 'a request at its expiry instant is refused');
select ok((select state = 'expired' and push_token is null and request_secret_hash is null and nonce_hash is null
           from private.push_registration_requests where id = '42000000-0000-4000-8000-000000000031'),
          'the expired request is closed as expired');
select is((select ok from public.confirm_push_registration('42000000-0000-4000-8000-000000000041', repeat('E', 43), repeat('F', 43))), true, 'a request 1 microsecond before expiry is confirmed');

-- token_change requests are for U1-C, not this RPC.
select is((select ok from public.confirm_push_registration('42000000-0000-4000-8000-000000000012', repeat('E', 43), repeat('F', 43))), false, 'a token_change request is not confirmed here');
select is((select state || ':' || failed_attempts::text from private.push_registration_requests where id = '42000000-0000-4000-8000-000000000012'), 'pending:0', 'the token_change request is left as it was');

-- ============================================================
-- Calls as client roles
-- ============================================================

insert into private.push_registration_requests
  (id, purpose, push_token, push_token_hash, request_secret_hash, nonce_hash, state, expires_at)
values
  ('42000000-0000-4000-8000-000000000051', 'new', 'test-token-q5', private.push_registration_hash('test-token-q5'),
   private.push_registration_hash(repeat('E', 43)), private.push_registration_hash(repeat('F', 43)), 'pending', now() + interval '10 minutes');

select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;

select is((select ok from public.confirm_push_registration('42000000-0000-4000-8000-000000000051', repeat('E', 43), repeat('F', 43))), true, 'anon can confirm a request');
select throws_ok(
  $$select * from public.create_push_registration_request('test-token-x', repeat('A', 43), repeat('B', 43))$$,
  '42501', null, 'anon cannot create a request'
);

reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000d0b02","role":"authenticated"}', true);
set local role authenticated;

select throws_ok(
  $$select * from public.confirm_push_registration('42000000-0000-4000-8000-000000000051', repeat('E', 43), repeat('F', 43))$$,
  '42501', null, 'authenticated cannot confirm a request'
);
select throws_ok(
  $$select * from public.create_push_registration_request('test-token-x', repeat('A', 43), repeat('B', 43))$$,
  '42501', null, 'authenticated cannot create a request'
);

reset role;

-- ============================================================
-- Time taken after the locks
-- ============================================================

-- The RPC's time is past the request's expiry once the request row is held.
insert into private.push_registration_requests
  (id, purpose, push_token, push_token_hash, request_secret_hash, nonce_hash, state, expires_at)
values
  ('42000000-0000-4000-8000-000000000071', 'new', 'test-token-q7', private.push_registration_hash('test-token-q7'),
   private.push_registration_hash(repeat('E', 43)), private.push_registration_hash(repeat('F', 43)), 'pending', now() + interval '10 minutes');

create or replace function private.push_registration_current_time()
returns timestamptz language sql volatile set search_path = '' as $$ select pg_catalog.now() + interval '11 minutes' $$;

select is((select ok from public.confirm_push_registration('42000000-0000-4000-8000-000000000071', repeat('E', 43), repeat('F', 43))), false, 'a request past its expiry at the time taken after the request lock is refused');
select ok((select state = 'expired' and closed_at = now() + interval '11 minutes'
             and push_token is null and request_secret_hash is null and nonce_hash is null
           from private.push_registration_requests where id = '42000000-0000-4000-8000-000000000071'),
          'it is closed as expired at that time, without its secrets');

-- Valid when the request row is held, expired by the time the registration
-- rows are held (first call: now(), later calls: 11 minutes on).
create temp sequence u1b_time_calls;
create or replace function private.push_registration_current_time()
returns timestamptz language sql volatile set search_path = '' as $$
  select case when pg_catalog.nextval('pg_temp.u1b_time_calls') = 1
              then pg_catalog.now() else pg_catalog.now() + interval '11 minutes' end
$$;

insert into private.push_device_registrations
  (id, status, push_token, push_token_hash, secret_hash, confirmed_token_generation, send_paused, notifications_enabled, expires_at)
values
  ('43000000-0000-4000-8000-000000000081', 'active', 'test-token-q8', private.push_registration_hash('test-token-q8'),
   '\xb8', 1, false, true, now() + interval '30 days');
insert into private.push_registration_requests
  (id, purpose, push_token, push_token_hash, request_secret_hash, nonce_hash, state, expires_at)
values
  ('42000000-0000-4000-8000-000000000081', 'new', 'test-token-q8', private.push_registration_hash('test-token-q8'),
   private.push_registration_hash(repeat('E', 43)), private.push_registration_hash(repeat('F', 43)), 'pending', now() + interval '10 minutes');

select is((select ok from public.confirm_push_registration('42000000-0000-4000-8000-000000000081', repeat('E', 43), repeat('F', 43))), false, 'a request that expires before the registration rows are held is refused');
select ok((select status = 'active' and push_token = 'test-token-q8' and secret_hash = '\xb8' and disabled_at is null
           from private.push_device_registrations where id = '43000000-0000-4000-8000-000000000081'),
          'the older registration for the token is not disabled');
select is((select count(*)::int from private.push_device_registrations where push_token_hash = private.push_registration_hash('test-token-q8')), 1, 'no registration is created');
select ok((select state = 'expired' and closed_at = now() + interval '11 minutes'
             and push_token is null and request_secret_hash is null and nonce_hash is null
           from private.push_registration_requests where id = '42000000-0000-4000-8000-000000000081'),
          'the request is closed as expired at the later time, without its secrets');

-- Limits count back from the time taken after the locks.
insert into private.push_registration_requests (purpose, push_token_hash, state, created_at, expires_at, closed_at)
select 'new', private.push_registration_hash('test-token-t1'), 'cancelled', now() - interval '30 minutes', now() - interval '20 minutes', now() - interval '25 minutes'
from generate_series(1, 3);

create or replace function private.push_registration_current_time()
returns timestamptz language sql volatile set search_path = '' as $$ select pg_catalog.now() $$;

select is((select result from public.create_push_registration_request('test-token-t1', repeat('A', 43), repeat('B', 43))), 'rate_limited', 'three requests in the last hour limit the token');

create or replace function private.push_registration_current_time()
returns timestamptz language sql volatile set search_path = '' as $$ select pg_catalog.now() + interval '31 minutes' $$;

select is((select result from public.create_push_registration_request('test-token-t1', repeat('A', 43), repeat('B', 43))), 'created', 'an hour after those requests, at the time taken after the locks, the token may request again');
select is((select expires_at from private.push_registration_requests where push_token_hash = private.push_registration_hash('test-token-t1') and state = 'pending'), now() + interval '41 minutes', 'the new request expires 10 minutes after that time');
select ok((select created_at = now() + interval '31 minutes' and expires_at = created_at + interval '10 minutes'
           from private.push_registration_requests where push_token_hash = private.push_registration_hash('test-token-t1') and state = 'pending'),
          'the new request is recorded as created at that time, the time the limits were checked');

-- A confirmation records the new registration at its final time.
insert into private.push_registration_requests
  (id, purpose, push_token, push_token_hash, request_secret_hash, nonce_hash, state, expires_at)
values
  ('42000000-0000-4000-8000-000000000091', 'new', 'test-token-q9', private.push_registration_hash('test-token-q9'),
   private.push_registration_hash(repeat('E', 43)), private.push_registration_hash(repeat('F', 43)), 'pending', now() + interval '10 minutes');

create or replace function private.push_registration_current_time()
returns timestamptz language sql volatile set search_path = '' as $$ select pg_catalog.now() + interval '5 minutes' $$;

create temp table u1b_time_confirmed on commit drop as
select * from public.confirm_push_registration('42000000-0000-4000-8000-000000000091', repeat('E', 43), repeat('F', 43));

select ok((select c.ok and d.created_at = now() + interval '5 minutes' and d.updated_at = d.created_at
             and d.expires_at = d.created_at + interval '2160 hours' and c.expires_at = d.expires_at
           from u1b_time_confirmed c join private.push_device_registrations d on d.id = c.registration_id),
          'the new registration is created, updated and expiring from the confirmation time');

create or replace function private.push_registration_current_time()
returns timestamptz language sql volatile set search_path = '' as $$ select pg_catalog.now() $$;

-- ============================================================
-- create_push_registration_request: overall limits
-- ============================================================

delete from private.push_registration_requests;

insert into private.push_registration_requests (purpose, push_token_hash, state, created_at, expires_at, closed_at)
select 'new', private.push_registration_hash('test-token-g' || i), 'cancelled', now() - interval '30 seconds', now() + interval '1 minute', now() - interval '10 seconds'
from generate_series(1, 60) i;

select is((select result from public.create_push_registration_request('test-token-g-new', repeat('A', 43), repeat('B', 43))), 'rate_limited', 'a 61st request within a minute is refused');
select is((select count(*)::int from private.push_registration_requests), 60, 'the refused request adds no row');

delete from private.push_registration_requests;

insert into private.push_registration_requests (purpose, push_token_hash, state, created_at, expires_at, closed_at)
select 'new', private.push_registration_hash('test-token-g' || i), 'expired', now() - interval '2 hours', now() - interval '110 minutes', now() - interval '110 minutes'
from generate_series(1, 2000) i;

select is((select result from public.create_push_registration_request('test-token-g-new', repeat('A', 43), repeat('B', 43))), 'rate_limited', 'a 2001st request within a day is refused');

delete from private.push_registration_requests where push_token_hash = private.push_registration_hash('test-token-g1');

select is((select result from public.create_push_registration_request('test-token-g-new', repeat('A', 43), repeat('B', 43))), 'created', 'a 2000th request within a day is created');

-- ============================================================
-- Intake closed again
-- ============================================================

create or replace function private.push_registration_intake_open()
returns boolean language sql stable set search_path = '' as $$ select false $$;

insert into private.push_registration_requests
  (id, purpose, push_token, push_token_hash, request_secret_hash, nonce_hash, state, expires_at)
values
  ('42000000-0000-4000-8000-000000000061', 'new', 'test-token-q6', private.push_registration_hash('test-token-q6'),
   private.push_registration_hash(repeat('E', 43)), private.push_registration_hash(repeat('F', 43)), 'pending', now() + interval '10 minutes');

select ok(not private.push_registration_intake_open(), 'intake is closed again');
select is((select result from public.create_push_registration_request('test-token-after', repeat('A', 43), repeat('B', 43))), 'intake_closed', 'closed again: request refused');
select is((select ok from public.confirm_push_registration('42000000-0000-4000-8000-000000000061', repeat('E', 43), repeat('F', 43))), false, 'closed again: confirmation refused');
select is((select state || ':' || failed_attempts::text from private.push_registration_requests where id = '42000000-0000-4000-8000-000000000061'), 'pending:0', 'closed again: the request is untouched');

select * from finish();

rollback;
