-- pgTAP tests for the push registration lifecycle RPCs (roadmap 3, U1-C).
-- Everything runs inside one transaction and is rolled back, including the
-- temporary replacements of private.push_token_change_open() (to test the
-- open path), private.push_registration_intake_open() and
-- private.push_registration_current_time() (to fix the time); the
-- migration's versions are checked first. Tokens and secrets are dummy
-- values; registration n has the secret lpad('n', 64, '0'). One
-- transaction cannot test real concurrency.

begin;

create extension if not exists pgtap with schema extensions;

select plan(124);

-- ============================================================
-- Structure, grants and gates (state right after the migration)
-- ============================================================

select has_function('public', 'renew_push_registration', array['text', 'text', 'text', 'text', 'boolean', 'boolean'], 'renew_push_registration exists');
select has_function('public', 'disable_push_registration', array['text', 'text'], 'disable_push_registration exists');
select has_function('public', 'create_push_token_change_request', array['text', 'text', 'text', 'text', 'text'], 'create_push_token_change_request exists');
select has_function('public', 'confirm_push_token_change', array['text', 'text', 'text', 'text'], 'confirm_push_token_change exists');
select ok((select count(*) = 4 and bool_and(prosecdef and proconfig @> array['search_path=""']) from pg_proc where oid in ('public.renew_push_registration(text, text, text, text, boolean, boolean)'::regprocedure, 'public.disable_push_registration(text, text)'::regprocedure, 'public.create_push_token_change_request(text, text, text, text, text)'::regprocedure, 'public.confirm_push_token_change(text, text, text, text)'::regprocedure)), 'the four RPCs are SECURITY DEFINER with empty search_path');
select ok(has_function_privilege('anon', 'public.renew_push_registration(text, text, text, text, boolean, boolean)', 'execute') and not (select bool_or(has_function_privilege(r, 'public.renew_push_registration(text, text, text, text, boolean, boolean)', 'execute')) from unnest(array['public','authenticated','service_role']) r), 'renew_push_registration: anon only');
select ok(has_function_privilege('anon', 'public.disable_push_registration(text, text)', 'execute') and not (select bool_or(has_function_privilege(r, 'public.disable_push_registration(text, text)', 'execute')) from unnest(array['public','authenticated','service_role']) r), 'disable_push_registration: anon only');
select ok(has_function_privilege('service_role', 'public.create_push_token_change_request(text, text, text, text, text)', 'execute') and not (select bool_or(has_function_privilege(r, 'public.create_push_token_change_request(text, text, text, text, text)', 'execute')) from unnest(array['public','anon','authenticated']) r), 'create_push_token_change_request: service_role only');
select ok(has_function_privilege('anon', 'public.confirm_push_token_change(text, text, text, text)', 'execute') and not (select bool_or(has_function_privilege(r, 'public.confirm_push_token_change(text, text, text, text)', 'execute')) from unnest(array['public','authenticated','service_role']) r), 'confirm_push_token_change: anon only');
select is(pg_catalog.pg_get_function_result('public.renew_push_registration(text, text, text, text, boolean, boolean)'::regprocedure), 'TABLE(ok boolean, result text, expires_at timestamp with time zone)', 'renew_push_registration returns (ok, result, expires_at)');
select is(pg_catalog.pg_get_function_result('public.disable_push_registration(text, text)'::regprocedure), 'TABLE(ok boolean, result text)', 'disable_push_registration returns (ok, result)');
select is(pg_catalog.pg_get_function_result('public.create_push_token_change_request(text, text, text, text, text)'::regprocedure), 'TABLE(ok boolean, result text, request_id uuid)', 'create_push_token_change_request returns (ok, result, request_id)');
select is(pg_catalog.pg_get_function_result('public.confirm_push_token_change(text, text, text, text)'::regprocedure), 'TABLE(ok boolean, confirmed_token_generation integer, expires_at timestamp with time zone)', 'confirm_push_token_change returns (ok, confirmed_token_generation, expires_at)');
select ok((select provolatile = 's' and not prosecdef and proconfig @> array['search_path=""'] and btrim(prosrc) = 'select false' from pg_proc where oid = 'private.push_token_change_open()'::regprocedure), 'the token change gate only returns false, stable, SECURITY INVOKER, empty search_path');
select ok(not private.push_token_change_open(), 'token change confirmation is closed after the migration');
select ok(not (select bool_or(has_function_privilege(r, 'private.push_token_change_open()', 'execute')) from unnest(array['public','anon','authenticated','service_role']) r), 'the token change gate is not executable by client roles');
select ok(not private.push_registration_intake_open(), 'registration intake is still closed');
select is((select btrim(prosrc) from pg_proc where oid = 'private.push_registration_current_time()'::regprocedure), 'select pg_catalog.clock_timestamp()', 'the time helper still returns clock_timestamp()');
select ok(not (select bool_or(has_table_privilege(r, t, p)) from unnest(array['public','anon','authenticated','service_role']) r, unnest(array['private.push_device_registrations','private.push_registration_requests']) t, unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p), 'still no table privilege for client roles');
select ok((select not prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'private.enforce_push_device_registration_transition()'::regprocedure) and not (select bool_or(has_function_privilege(r, 'private.enforce_push_device_registration_transition()', 'execute')) from unnest(array['public','anon','authenticated','service_role']) r), 'the replaced transition guard is SECURITY INVOKER with empty search_path, not executable by clients');

-- Fix the RPCs' time to now() (the transaction start) so expectations below
-- are exact; some tests move it. Rolled back with the rest.
create or replace function private.push_registration_current_time()
returns timestamptz language sql volatile set search_path = '' as $$ select pg_catalog.now() $$;

-- ============================================================
-- Fixtures (owner context, dummy values)
-- ============================================================

insert into private.push_device_registrations
  (id, status, push_token, push_token_hash, secret_hash, confirmed_token_generation, send_paused, notifications_enabled, created_at, expires_at)
select ('50000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'active',
       'test-token-u' || lpad(n::text, 2, '0'), private.push_registration_hash('test-token-u' || lpad(n::text, 2, '0')),
       private.push_registration_hash(lpad(n::text, 64, '0')), 1, paused, notifications, now() - interval '2160 hours', expires
from (values
  (1, false, true, now() + interval '1080 hours'),                       -- due: exactly 45 x 24 hours remain
  (2, false, true, now() + interval '1080 hours' + interval '1 microsecond'), -- not due yet
  (3, false, true, now()),                                               -- expires at this instant
  (4, false, true, now() + interval '1 microsecond'),                    -- expires 1 microsecond from now
  (5, false, false, now() + interval '240 hours'),                       -- notifications off
  (6, true, true, now() + interval '240 hours'),                         -- paused (B3)
  (8, false, true, now() + interval '720 hours'),                        -- disable
  (9, false, true, now() + interval '1440 hours'),                       -- token change
  (10, true, true, now() + interval '1440 hours'),                       -- paused, with an older pending request
  (11, false, true, now()),                                              -- expired, token change
  (12, false, true, now() + interval '1440 hours'),                      -- rate limit
  (13, false, true, now() + interval '1440 hours'),                      -- moves to u14's token
  (14, false, true, now() + interval '1440 hours'),
  (15, false, true, now() + interval '1440 hours'),                      -- u15 and u16 swap tokens
  (16, false, true, now() + interval '1440 hours'),
  (17, false, true, now() + interval '1440 hours'),                      -- five failures
  (18, false, true, now() + interval '5 minutes'),                       -- expires before confirming
  (19, false, true, now() + interval '1440 hours'),                      -- disabled before confirming
  (20, false, true, now() + interval '1440 hours'),                      -- wrong registration secret
  (21, true, true, now() + interval '1440 hours'),                       -- paused, replaced by a new registration (RPC-2)
  (22, false, true, now() + interval '1440 hours'),                      -- request at its expiry instant
  (23, false, true, now() + interval '1440 hours'),                      -- transition guard
  (24, true, true, now() + interval '1440 hours'),                       -- transition guard, paused
  (25, true, true, now() + interval '1440 hours'),                       -- request expires before the registration rows are held
  (26, false, true, now() + interval '1440 hours'),                      -- request 1 microsecond before expiry
  (27, true, true, now() + interval '1440 hours'),                       -- rate limit, paused, with an older pending request
  (28, false, true, now() + interval '1440 hours')                       -- rate limit, unauthorized and no_change
) v(n, paused, notifications, expires);

insert into private.push_device_registrations
  (id, status, push_token_hash, confirmed_token_generation, send_paused, notifications_enabled, created_at, expires_at, disabled_at, disabled_reason)
values
  ('50000000-0000-4000-8000-000000000007', 'disabled', private.push_registration_hash('test-token-u07'), 1, false, true,
   now() - interval '2160 hours', now() + interval '240 hours', now() - interval '24 hours', 'user_disabled');

insert into private.push_registration_requests
  (id, purpose, registration_id, push_token, push_token_hash, request_secret_hash, nonce_hash, state, expires_at)
values
  ('51000000-0000-4000-8000-000000000010', 'token_change', '50000000-0000-4000-8000-000000000010', 'test-token-u10-b', private.push_registration_hash('test-token-u10-b'),
   private.push_registration_hash(repeat('A', 43)), private.push_registration_hash(repeat('B', 43)), 'pending', now() + interval '10 minutes'),
  ('51000000-0000-4000-8000-000000000025', 'token_change', '50000000-0000-4000-8000-000000000025', 'test-token-u25-b', private.push_registration_hash('test-token-u25-b'),
   private.push_registration_hash(repeat('A', 43)), private.push_registration_hash(repeat('B', 43)), 'pending', now() + interval '10 minutes'),
  ('51000000-0000-4000-8000-000000000027', 'token_change', '50000000-0000-4000-8000-000000000027', 'test-token-u27-old', private.push_registration_hash('test-token-u27-old'),
   private.push_registration_hash(repeat('A', 43)), private.push_registration_hash(repeat('B', 43)), 'pending', now() + interval '10 minutes'),
  ('51000000-0000-4000-8000-000000000040', 'new', null, 'test-token-n40', private.push_registration_hash('test-token-n40'),
   private.push_registration_hash(repeat('A', 43)), private.push_registration_hash(repeat('B', 43)), 'pending', now() + interval '10 minutes');

-- ============================================================
-- renew_push_registration
-- ============================================================

select is((select result from public.renew_push_registration('50000000-0000-4000-8000-000000000001', lpad('1', 63, '0'), 'test-token-u01', '1', true, true)), 'invalid_input', 'renew: a secret of 63 characters is invalid');
select is((select result from public.renew_push_registration('50000000-0000-4000-8000-000000000001', lpad('1', 64, '0'), 'test-token-u01', '0', true, true)), 'invalid_input', 'renew: generation 0 is invalid');
select is((select result from public.renew_push_registration('50000000-0000-4000-8000-000000000001', lpad('1', 64, '0'), repeat('a', 100000), '1', true, true)), 'invalid_input', 'renew: an oversized token is invalid');
select is((select result from public.renew_push_registration('50000000-0000-4000-8000-0000000000ff', lpad('1', 64, '0'), 'test-token-u01', '1', true, true)), 'unauthorized', 'renew: an unknown registration is unauthorized');
select is((select result from public.renew_push_registration('50000000-0000-4000-8000-000000000001', lpad('2', 64, '0'), 'test-token-u01', '1', true, true)), 'unauthorized', 'renew: a wrong secret is unauthorized');
select ok((select not ok and result = 'unauthorized' and expires_at is null from public.renew_push_registration('50000000-0000-4000-8000-000000000007', lpad('7', 64, '0'), 'test-token-u07', '1', true, true)), 'renew: a disabled registration gets the same result as a wrong secret');
select is((select result from public.renew_push_registration('50000000-0000-4000-8000-000000000003', lpad('3', 64, '0'), 'test-token-u03', '1', true, true)), 'expired', 'renew: a registration at its expiry instant has expired');
select is((select result from public.renew_push_registration('50000000-0000-4000-8000-000000000005', lpad('5', 64, '0'), 'test-token-u05', '1', true, true)), 'notifications_off', 'renew: notifications switched off are refused');
select is((select result from public.renew_push_registration('50000000-0000-4000-8000-000000000006', lpad('6', 64, '0'), 'test-token-u06', '1', true, true)), 'send_paused', 'renew: a paused registration (B3) is refused');
select is((select result from public.renew_push_registration('50000000-0000-4000-8000-000000000001', lpad('1', 64, '0'), 'test-token-other', '1', true, true)), 'token_mismatch', 'renew: another token is refused');
select is((select result from public.renew_push_registration('50000000-0000-4000-8000-000000000001', lpad('1', 64, '0'), 'test-token-u01', '2', true, true)), 'generation_mismatch', 'renew: another generation is refused');
select is((select result from public.renew_push_registration('50000000-0000-4000-8000-000000000001', lpad('1', 64, '0'), 'test-token-u01', '1', false, true)), 'os_permission_not_granted', 'renew: OS permission not granted is refused');
select is((select result from public.renew_push_registration('50000000-0000-4000-8000-000000000001', lpad('1', 64, '0'), 'test-token-u01', '1', null, true)), 'os_permission_not_granted', 'renew: OS permission not reported is refused');
select is((select result from public.renew_push_registration('50000000-0000-4000-8000-000000000001', lpad('1', 64, '0'), 'test-token-u01', '1', true, false)), 'device_check_failed', 'renew: a failed device check is refused');
select ok((select bool_and(expires_at = e) from private.push_device_registrations d
           join (values ('50000000-0000-4000-8000-000000000001'::uuid, now() + interval '1080 hours'), ('50000000-0000-4000-8000-000000000003'::uuid, now()),
                        ('50000000-0000-4000-8000-000000000005'::uuid, now() + interval '240 hours'), ('50000000-0000-4000-8000-000000000006'::uuid, now() + interval '240 hours')) v(i, e) on v.i = d.id)
          and (select status = 'active' and not notifications_enabled from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000005')
          and (select status = 'disabled' and secret_hash is null from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000007'),
          'renew: refused calls change nothing (no extension, no notifications or registration turned back on)');
select ok((select ok and result = 'not_due' and expires_at = now() + interval '1080 hours' + interval '1 microsecond' from public.renew_push_registration('50000000-0000-4000-8000-000000000002', lpad('2', 64, '0'), 'test-token-u02', '1', true, true)), 'renew: more than 45 x 24 hours left is not due and returns the current expiry');
select is((select expires_at from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000002'), now() + interval '1080 hours' + interval '1 microsecond', 'renew: not due writes nothing');
select ok((select ok and result = 'renewed' and expires_at = now() + interval '2160 hours' from public.renew_push_registration('50000000-0000-4000-8000-000000000001', lpad('1', 64, '0'), 'test-token-u01', '1', true, true)), 'renew: exactly 45 x 24 hours left is renewed for 90 x 24 hours');
select is((select expires_at from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000001'), now() + interval '2160 hours', 'renew: the new expiry is stored');
select is((select result from public.renew_push_registration('50000000-0000-4000-8000-000000000004', lpad('4', 64, '0'), 'test-token-u04', '1', true, true)), 'renewed', 'renew: 1 microsecond before expiry is renewed');

-- The time taken after the lock decides: 1 microsecond later, u02 is due.
create or replace function private.push_registration_current_time()
returns timestamptz language sql volatile set search_path = '' as $$ select pg_catalog.now() + interval '1 microsecond' $$;

select ok((select ok and result = 'renewed' and expires_at = now() + interval '1 microsecond' + interval '2160 hours' from public.renew_push_registration('50000000-0000-4000-8000-000000000002', lpad('2', 64, '0'), 'test-token-u02', '1', true, true)), 'renew: due and renewed from the time taken after the lock');

create or replace function private.push_registration_current_time()
returns timestamptz language sql volatile set search_path = '' as $$ select pg_catalog.now() $$;

-- ============================================================
-- disable_push_registration
-- ============================================================

select is((select result from public.disable_push_registration('50000000-0000-4000-8000-000000000008', repeat('A', 64))), 'unauthorized', 'disable: a malformed secret is unauthorized');
select is((select result from public.disable_push_registration('50000000-0000-4000-8000-0000000000ff', lpad('8', 64, '0'))), 'unauthorized', 'disable: an unknown registration is unauthorized');
select is((select result from public.disable_push_registration('50000000-0000-4000-8000-000000000008', lpad('9', 64, '0'))), 'unauthorized', 'disable: a wrong secret is unauthorized');
select ok((select status = 'active' and secret_hash = private.push_registration_hash(lpad('8', 64, '0')) from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000008'), 'disable: an unauthorized call changes nothing');
select ok((select ok and result = 'disabled' from public.disable_push_registration('50000000-0000-4000-8000-000000000008', lpad('8', 64, '0'))), 'disable: the right secret disables the registration');
select ok((select status = 'disabled' and disabled_reason = 'user_disabled' and disabled_at = now()
             and push_token is null and secret_hash is null and push_token_hash = private.push_registration_hash('test-token-u08')
           from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000008'),
          'disable: disabled as user_disabled, without its token and secret');
select is((select ok::text || ':' || result from public.disable_push_registration('50000000-0000-4000-8000-000000000008', lpad('8', 64, '0'))), 'false:unauthorized', 'disable: a second call is unauthorized, like a wrong secret (only disabled confirms the stop)');
select is((select result from public.renew_push_registration('50000000-0000-4000-8000-000000000008', lpad('8', 64, '0'), 'test-token-u08', '1', true, true)), 'unauthorized', 'disable: a disabled registration cannot be renewed');
select is((select result from public.create_push_token_change_request('50000000-0000-4000-8000-000000000008', lpad('8', 64, '0'), 'test-token-u08-b', repeat('A', 43), repeat('B', 43))), 'unauthorized', 'disable: a disabled registration cannot start a token change');
select is((select result from public.disable_push_registration('50000000-0000-4000-8000-000000000003', lpad('3', 64, '0'))), 'disabled', 'disable: an expired registration can be disabled');

-- ============================================================
-- create_push_token_change_request: confirmation closed
-- ============================================================

select is((select result from public.create_push_token_change_request('50000000-0000-4000-8000-000000000009', lpad('9', 64, '0'), 'test-token-u09-c', repeat('A', 43), repeat('A', 43))), 'invalid_input', 'token change: a request secret equal to the nonce is invalid');
select is((select result from public.create_push_token_change_request('50000000-0000-4000-8000-000000000009', lpad('8', 64, '0'), 'test-token-u09-c', repeat('A', 43), repeat('B', 43))), 'unauthorized', 'token change: a wrong secret is unauthorized');
select is((select result from public.create_push_token_change_request('50000000-0000-4000-8000-000000000011', lpad('11', 64, '0'), 'test-token-u11-c', repeat('A', 43), repeat('B', 43))), 'expired', 'token change: an expired registration is refused');
select is((select result from public.create_push_token_change_request('50000000-0000-4000-8000-000000000009', lpad('9', 64, '0'), 'test-token-u09', repeat('A', 43), repeat('B', 43))), 'no_change', 'token change: the current token, not paused, is no change');
select ok((select not send_paused from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000009')
          and (select not send_paused from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000011'),
          'token change: unauthorized, expired and no_change leave sending as it was');
select ok((select not ok and result = 'deferred' and request_id is null from public.create_push_token_change_request('50000000-0000-4000-8000-000000000009', lpad('9', 64, '0'), 'test-token-u09-c', repeat('A', 43), repeat('B', 43))), 'token change: closed confirmation defers the request');
select ok((select send_paused and push_token = 'test-token-u09' and confirmed_token_generation = 1 from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000009')
          and (select count(*) = 0 from private.push_registration_requests where push_token_hash = private.push_registration_hash('test-token-u09-c')),
          'token change: deferred pauses sending (old and new token) and creates no request, so no confirmation push');
select is((select result from public.create_push_token_change_request('50000000-0000-4000-8000-000000000009', lpad('9', 64, '0'), 'test-token-u09', repeat('A', 43), repeat('B', 43))), 'deferred', 'token change: back to the current token while paused is not no_change and still needs a confirmation');
select is((select result from public.create_push_token_change_request('50000000-0000-4000-8000-000000000010', lpad('10', 64, '0'), 'test-token-u10-c', repeat('A', 43), repeat('B', 43))), 'deferred', 'token change: deferred with an older pending request');
select ok((select state = 'cancelled' and closed_at = now() and push_token is null and request_secret_hash is null and nonce_hash is null
           from private.push_registration_requests where id = '51000000-0000-4000-8000-000000000010')
          and (select send_paused from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000010'),
          'token change: deferred cancels the registration''s older pending request and keeps sending paused');
select is((select ok from public.confirm_push_token_change('51000000-0000-4000-8000-000000000025', lpad('25', 64, '0'), repeat('A', 43), repeat('B', 43))), false, 'confirm: closed confirmation refuses even matching values');
select ok((select state = 'pending' and failed_attempts = 0 from private.push_registration_requests where id = '51000000-0000-4000-8000-000000000025')
          and (select send_paused and confirmed_token_generation = 1 and push_token = 'test-token-u25' from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000025'),
          'confirm: closed, nothing changes and sending stays paused');

-- ============================================================
-- Token change with confirmation open (this transaction only)
-- ============================================================

create or replace function private.push_token_change_open()
returns boolean language sql stable set search_path = '' as $$ select true $$;

-- Back to the current token while paused: confirmed like any other token.
create temp table u1c_req_09 on commit drop as
select * from public.create_push_token_change_request('50000000-0000-4000-8000-000000000009', lpad('9', 64, '0'), 'test-token-u09', repeat('A', 43), repeat('B', 43));

select ok((select c.ok and c.result = 'created' and r.purpose = 'token_change' and r.registration_id = '50000000-0000-4000-8000-000000000009'
             and r.state = 'pending' and r.push_token = 'test-token-u09' and r.push_token_hash = private.push_registration_hash('test-token-u09')
             and r.request_secret_hash = private.push_registration_hash(repeat('A', 43)) and r.nonce_hash = private.push_registration_hash(repeat('B', 43))
             and r.created_at = now() and r.expires_at = now() + interval '10 minutes' and r.failed_attempts = 0
           from u1c_req_09 c join private.push_registration_requests r on r.id = c.request_id),
          'token change: a request stores only hashes and expires after 10 minutes');
select is((select ok from public.confirm_push_token_change((select request_id::text from u1c_req_09), lpad('9', 64, '0'), repeat('A', 43), repeat('X', 43))), false, 'confirm: a wrong nonce is refused');
select ok((select failed_attempts = 1 and state = 'pending' from private.push_registration_requests where id = (select request_id from u1c_req_09))
          and (select send_paused and confirmed_token_generation = 1 from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000009'),
          'confirm: the failure is counted and sending stays paused');

create temp table u1c_conf_09 on commit drop as
select * from public.confirm_push_token_change((select request_id::text from u1c_req_09), lpad('9', 64, '0'), repeat('A', 43), repeat('B', 43));

select ok((select c.ok and c.confirmed_token_generation = 2 and c.expires_at = now() + interval '1440 hours' from u1c_conf_09 c), 'confirm: matching values confirm generation 2 without extending the expiry');
select ok((select status = 'active' and not send_paused and confirmed_token_generation = 2 and push_token = 'test-token-u09'
             and secret_hash = private.push_registration_hash(lpad('9', 64, '0')) and expires_at = now() + interval '1440 hours'
           from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000009'),
          'confirm: sending resumes only now, on the confirmed token');
select ok((select state = 'consumed' and closed_at = now() and push_token is null and request_secret_hash is null and nonce_hash is null
           from private.push_registration_requests where id = (select request_id from u1c_req_09)),
          'confirm: the request is consumed with its secrets removed');
select is((select ok from public.confirm_push_token_change((select request_id::text from u1c_req_09), lpad('9', 64, '0'), repeat('A', 43), repeat('B', 43))), false, 'confirm: a used nonce cannot confirm again');
select is((select ok from public.confirm_push_token_change('51000000-0000-4000-8000-000000000010', lpad('10', 64, '0'), repeat('A', 43), repeat('B', 43))), false, 'confirm: a request cancelled while closed stays refused once open');

-- A new token another registration has: that registration is replaced.
create temp table u1c_req_13 on commit drop as
select * from public.create_push_token_change_request('50000000-0000-4000-8000-000000000013', lpad('13', 64, '0'), 'test-token-u14', repeat('A', 43), repeat('B', 43));

select ok((select ok from u1c_req_13) and (select send_paused and push_token = 'test-token-u13' from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000013'), 'token change: created and paused');
select is((select ok from public.confirm_push_token_change((select request_id::text from u1c_req_13), lpad('13', 64, '0'), repeat('A', 43), repeat('B', 43))), true, 'confirm: the change to another registration''s token is confirmed');
select ok((select status = 'active' and not send_paused and confirmed_token_generation = 2 and push_token = 'test-token-u14'
             and push_token_hash = private.push_registration_hash('test-token-u14')
           from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000013'),
          'confirm: the registration moves to the new token at generation 2');
select ok((select status = 'disabled' and disabled_reason = 'replaced_by_token_change' and disabled_at = now() and push_token is null and secret_hash is null
           from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000014'),
          'confirm: the registration that had the token is disabled without its token and secret');
select is((select count(*)::int from private.push_device_registrations where push_token_hash = private.push_registration_hash('test-token-u14') and status = 'active'), 1, 'confirm: one active registration for the token');

-- Two registrations changing to each other's tokens (one after the other).
create temp table u1c_req_15 on commit drop as
select * from public.create_push_token_change_request('50000000-0000-4000-8000-000000000015', lpad('15', 64, '0'), 'test-token-u16', repeat('A', 43), repeat('B', 43));
create temp table u1c_req_16 on commit drop as
select * from public.create_push_token_change_request('50000000-0000-4000-8000-000000000016', lpad('16', 64, '0'), 'test-token-u15', repeat('A', 43), repeat('B', 43));

select ok((select ok from u1c_req_15) and (select ok from u1c_req_16), 'swap: both requests are created (their token hashes differ)');
select is((select ok from public.confirm_push_token_change((select request_id::text from u1c_req_15), lpad('15', 64, '0'), repeat('A', 43), repeat('B', 43))), true, 'swap: the first confirmation succeeds');
select is((select ok from public.confirm_push_token_change((select request_id::text from u1c_req_16), lpad('16', 64, '0'), repeat('A', 43), repeat('B', 43))), false, 'swap: the second is refused, its registration having been replaced');
select ok((select state = 'cancelled' and request_secret_hash is null from private.push_registration_requests where id = (select request_id from u1c_req_16))
          and (select status = 'active' and push_token = 'test-token-u16' from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000015')
          and (select status = 'disabled' and disabled_reason = 'replaced_by_token_change' from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000016'),
          'swap: the refused request is cancelled and the disabled registration stays disabled');

-- Five failures close a request; sending stays paused.
create temp table u1c_req_17 on commit drop as
select * from public.create_push_token_change_request('50000000-0000-4000-8000-000000000017', lpad('17', 64, '0'), 'test-token-u17-b', repeat('A', 43), repeat('B', 43));

select is((select count(*)::int from generate_series(1, 4) g
           cross join lateral public.confirm_push_token_change((select request_id::text from u1c_req_17), lpad('17', 64, '0'), left(repeat('X', 43) || g::text, 43), repeat('B', 43)) c
           where not c.ok), 4, 'failures: four mismatches are refused');
select is((select ok from public.confirm_push_token_change((select request_id::text from u1c_req_17), lpad('17', 64, '0'), repeat('X', 43), repeat('B', 43))), false, 'failures: the fifth mismatch is refused');
select ok((select state = 'cancelled' and failed_attempts = 5 and request_secret_hash is null from private.push_registration_requests where id = (select request_id from u1c_req_17))
          and (select send_paused and confirmed_token_generation = 1 from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000017'),
          'failures: the fifth failure cancels the request and sending stays paused');
select is((select ok from public.confirm_push_token_change((select request_id::text from u1c_req_17), lpad('17', 64, '0'), repeat('A', 43), repeat('B', 43))), false, 'failures: a cancelled request cannot be confirmed with matching values');

-- Request expiry (exclusive), at the time taken after the request lock.
create temp table u1c_req_22 on commit drop as
select * from public.create_push_token_change_request('50000000-0000-4000-8000-000000000022', lpad('22', 64, '0'), 'test-token-u22-b', repeat('A', 43), repeat('B', 43));
create temp table u1c_req_26 on commit drop as
select * from public.create_push_token_change_request('50000000-0000-4000-8000-000000000026', lpad('26', 64, '0'), 'test-token-u26-b', repeat('A', 43), repeat('B', 43));

create or replace function private.push_registration_current_time()
returns timestamptz language sql volatile set search_path = '' as $$ select pg_catalog.now() + interval '10 minutes' $$;

select is((select ok from public.confirm_push_token_change((select request_id::text from u1c_req_22), lpad('22', 64, '0'), repeat('A', 43), repeat('B', 43))), false, 'ttl: a request at its expiry instant is refused');
select ok((select state = 'expired' and closed_at = now() + interval '10 minutes' and request_secret_hash is null from private.push_registration_requests where id = (select request_id from u1c_req_22))
          and (select send_paused and confirmed_token_generation = 1 from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000022'),
          'ttl: it is closed as expired and sending stays paused');

create or replace function private.push_registration_current_time()
returns timestamptz language sql volatile set search_path = '' as $$ select pg_catalog.now() + interval '10 minutes' - interval '1 microsecond' $$;

select is((select ok from public.confirm_push_token_change((select request_id::text from u1c_req_26), lpad('26', 64, '0'), repeat('A', 43), repeat('B', 43))), true, 'ttl: a request 1 microsecond before expiry is confirmed');

-- The registration expires before the confirmation: not revived.
create or replace function private.push_registration_current_time()
returns timestamptz language sql volatile set search_path = '' as $$ select pg_catalog.now() $$;

create temp table u1c_req_18 on commit drop as
select * from public.create_push_token_change_request('50000000-0000-4000-8000-000000000018', lpad('18', 64, '0'), 'test-token-u18-b', repeat('A', 43), repeat('B', 43));

create or replace function private.push_registration_current_time()
returns timestamptz language sql volatile set search_path = '' as $$ select pg_catalog.now() + interval '6 minutes' $$;

select is((select ok from public.confirm_push_token_change((select request_id::text from u1c_req_18), lpad('18', 64, '0'), repeat('A', 43), repeat('B', 43))), false, 'expired registration: the confirmation is refused');
select ok((select state = 'cancelled' and closed_at = now() + interval '6 minutes' from private.push_registration_requests where id = (select request_id from u1c_req_18))
          and (select status = 'active' and send_paused and confirmed_token_generation = 1 and push_token = 'test-token-u18' and expires_at = now() + interval '5 minutes'
               from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000018'),
          'expired registration: the request is cancelled; no new token, no resume, no extension');

create or replace function private.push_registration_current_time()
returns timestamptz language sql volatile set search_path = '' as $$ select pg_catalog.now() $$;

-- The registration is disabled before the confirmation.
create temp table u1c_req_19 on commit drop as
select * from public.create_push_token_change_request('50000000-0000-4000-8000-000000000019', lpad('19', 64, '0'), 'test-token-u19-b', repeat('A', 43), repeat('B', 43));

select ok((select ok and result = 'disabled' from public.disable_push_registration('50000000-0000-4000-8000-000000000019', lpad('19', 64, '0')))
          and (select state = 'pending' from private.push_registration_requests where id = (select request_id from u1c_req_19)),
          'disabled registration: disabling leaves its pending request to the confirmation');
select is((select ok from public.confirm_push_token_change((select request_id::text from u1c_req_19), lpad('19', 64, '0'), repeat('A', 43), repeat('B', 43))), false, 'disabled registration: the confirmation is refused');
select ok((select state = 'cancelled' and request_secret_hash is null from private.push_registration_requests where id = (select request_id from u1c_req_19))
          and (select status = 'disabled' from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000019'),
          'disabled registration: the request is cancelled and the registration stays disabled');

-- A wrong registration secret with the right request secret and nonce.
create temp table u1c_req_20 on commit drop as
select * from public.create_push_token_change_request('50000000-0000-4000-8000-000000000020', lpad('20', 64, '0'), 'test-token-u20-b', repeat('A', 43), repeat('B', 43));

select is((select ok from public.confirm_push_token_change((select request_id::text from u1c_req_20), lpad('21', 64, '0'), repeat('A', 43), repeat('B', 43))), false, 'registration secret: a wrong one is refused');
select ok((select state = 'cancelled' from private.push_registration_requests where id = (select request_id from u1c_req_20))
          and (select send_paused and confirmed_token_generation = 1 and push_token = 'test-token-u20' from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000020'),
          'registration secret: the request is cancelled and sending stays paused');

-- Valid when the request row is held, expired by the time the registration
-- rows are held (first call: now(), later calls: 11 minutes on).
create temp sequence u1c_time_calls;
create or replace function private.push_registration_current_time()
returns timestamptz language sql volatile set search_path = '' as $$
  select case when pg_catalog.nextval('pg_temp.u1c_time_calls') = 1
              then pg_catalog.now() else pg_catalog.now() + interval '11 minutes' end
$$;

select is((select ok from public.confirm_push_token_change('51000000-0000-4000-8000-000000000025', lpad('25', 64, '0'), repeat('A', 43), repeat('B', 43))), false, 'time after locks: a request that expires before the registration rows are held is refused');
select ok((select state = 'expired' and closed_at = now() + interval '11 minutes' from private.push_registration_requests where id = '51000000-0000-4000-8000-000000000025')
          and (select send_paused and confirmed_token_generation = 1 and push_token = 'test-token-u25' from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000025'),
          'time after locks: it is closed as expired at the later time; the registration is unchanged');

create or replace function private.push_registration_current_time()
returns timestamptz language sql volatile set search_path = '' as $$ select pg_catalog.now() $$;

-- Requests of the other purpose.
select is((select ok from public.confirm_push_token_change('51000000-0000-4000-8000-000000000040', lpad('1', 64, '0'), repeat('A', 43), repeat('B', 43))), false, 'confirm: a new-registration request is not confirmed here');
select is((select state || ':' || failed_attempts::text from private.push_registration_requests where id = '51000000-0000-4000-8000-000000000040'), 'pending:0', 'confirm: the new-registration request is left as it was');

-- The U1-B limits count requests for the new token.
insert into private.push_registration_requests (purpose, push_token_hash, state, created_at, expires_at, closed_at)
select 'new', private.push_registration_hash('test-token-u12-b'), 'cancelled', now() - interval '30 minutes', now() - interval '20 minutes', now() - interval '25 minutes'
from generate_series(1, 3);

select is((select result from public.create_push_token_change_request('50000000-0000-4000-8000-000000000012', lpad('12', 64, '0'), 'test-token-u12-b', repeat('A', 43), repeat('B', 43))), 'rate_limited', 'limits: a fourth request for the token within an hour is refused');
select ok((select send_paused and confirmed_token_generation = 1 and push_token = 'test-token-u12' from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000012')
          and (select count(*) = 0 from private.push_registration_requests where registration_id = '50000000-0000-4000-8000-000000000012'),
          'limits: a refused change creates no request but still pauses sending (B3)');

-- Rate limited with an older pending request; and calls that must not pause.
insert into private.push_registration_requests (purpose, push_token_hash, state, created_at, expires_at, closed_at)
select 'new', private.push_registration_hash(t), 'cancelled', now() - interval '30 minutes', now() - interval '20 minutes', now() - interval '25 minutes'
from unnest(array['test-token-u27-b', 'test-token-u28-b']) t, generate_series(1, 3);

create temp table u1c_req_27 on commit drop as
select * from public.create_push_token_change_request('50000000-0000-4000-8000-000000000027', lpad('27', 64, '0'), 'test-token-u27-b', repeat('A', 43), repeat('B', 43));

select ok((select not ok and result = 'rate_limited' and request_id is null from u1c_req_27), 'limits: rate_limited returns ok = false and no request id');
select ok((select state = 'cancelled' and closed_at = now() and push_token is null and request_secret_hash is null and nonce_hash is null
           from private.push_registration_requests where id = '51000000-0000-4000-8000-000000000027'),
          'limits: the registration''s older pending request is still cancelled, its secrets removed');
select ok((select count(*) = 0 from private.push_registration_requests where push_token_hash = private.push_registration_hash('test-token-u27-b') and state = 'pending')
          and (select count(*) = 1 from private.push_registration_requests where registration_id = '50000000-0000-4000-8000-000000000027'),
          'limits: no new request is created');
select ok((select send_paused and confirmed_token_generation = 1 and push_token = 'test-token-u27' from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000027'), 'limits: sending stays paused on the old token, the generation unchanged');
select is((select result from public.renew_push_registration('50000000-0000-4000-8000-000000000027', lpad('27', 64, '0'), 'test-token-u27', '1', true, true)), 'send_paused', 'limits: the paused registration is not renewed or resumed without a confirmation');
select ok((select result = 'unauthorized' from public.create_push_token_change_request('50000000-0000-4000-8000-000000000028', lpad('27', 64, '0'), 'test-token-u28-b', repeat('A', 43), repeat('B', 43)))
          and (select not send_paused from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000028'),
          'limits: a wrong secret cannot pause another registration, even for a rate-limited token');
select ok((select result = 'no_change' from public.create_push_token_change_request('50000000-0000-4000-8000-000000000028', lpad('28', 64, '0'), 'test-token-u28', repeat('A', 43), repeat('B', 43)))
          and (select not send_paused from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000028'),
          'limits: no_change with confirmation open does not pause');

-- ============================================================
-- Transition guard (owner context)
-- ============================================================

select throws_ok(
  $$update private.push_device_registrations set confirmed_token_generation = 2
    where id = '50000000-0000-4000-8000-000000000023'$$,
  '55000', null, 'guard: the generation alone cannot go up'
);
select throws_ok(
  $$update private.push_device_registrations set send_paused = false
    where id = '50000000-0000-4000-8000-000000000024'$$,
  '55000', null, 'guard: a pause cannot be lifted alone'
);
select throws_ok(
  $$update private.push_device_registrations set push_token = 'test-token-u23-x', push_token_hash = private.push_registration_hash('test-token-u23-x')
    where id = '50000000-0000-4000-8000-000000000023'$$,
  '55000', null, 'guard: the token of an active registration cannot change alone'
);
select lives_ok(
  $$update private.push_device_registrations set send_paused = true, expires_at = expires_at + interval '1 hour'
    where id = '50000000-0000-4000-8000-000000000023'$$,
  'guard: pausing and extending are accepted'
);
select lives_ok(
  $$update private.push_device_registrations
    set push_token = 'test-token-u24-x', push_token_hash = private.push_registration_hash('test-token-u24-x'), confirmed_token_generation = 2, send_paused = false
    where id = '50000000-0000-4000-8000-000000000024'$$,
  'guard: a new token with the next generation, resuming a paused registration, is accepted'
);
select lives_ok(
  $$update private.push_device_registrations
    set status = 'disabled', disabled_at = now(), disabled_reason = 'user_disabled', push_token = null, secret_hash = null
    where id = '50000000-0000-4000-8000-000000000023'$$,
  'guard: disabling a paused registration, keeping its token hash, is accepted'
);

-- ============================================================
-- confirm_push_registration (U1-B) with the stronger guard
-- ============================================================

create or replace function private.push_registration_intake_open()
returns boolean language sql stable set search_path = '' as $$ select true $$;

insert into private.push_registration_requests
  (id, purpose, push_token, push_token_hash, request_secret_hash, nonce_hash, state, expires_at)
values
  ('51000000-0000-4000-8000-000000000021', 'new', 'test-token-u21', private.push_registration_hash('test-token-u21'),
   private.push_registration_hash(repeat('A', 43)), private.push_registration_hash(repeat('B', 43)), 'pending', now() + interval '10 minutes');

select is((select ok from public.confirm_push_registration('51000000-0000-4000-8000-000000000021', repeat('A', 43), repeat('B', 43))), true, 'U1-B: a new registration for a paused registration''s token is confirmed');
select ok((select status = 'disabled' and disabled_reason = 'replaced_by_new_registration' and secret_hash is null from private.push_device_registrations where id = '50000000-0000-4000-8000-000000000021'), 'U1-B: the paused registration is replaced');

create or replace function private.push_registration_intake_open()
returns boolean language sql stable set search_path = '' as $$ select false $$;

-- ============================================================
-- Calls as client roles
-- ============================================================

select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;

select is((select result from public.renew_push_registration('50000000-0000-4000-8000-0000000000fe', lpad('1', 64, '0'), 'test-token-x', '1', true, true)), 'unauthorized', 'anon can call renew');
select is((select result from public.disable_push_registration('50000000-0000-4000-8000-0000000000fe', lpad('1', 64, '0'))), 'unauthorized', 'anon can call disable');
select is((select ok from public.confirm_push_token_change('51000000-0000-4000-8000-0000000000fe', lpad('1', 64, '0'), repeat('A', 43), repeat('B', 43))), false, 'anon can call the token change confirmation');
select throws_ok(
  $$select * from public.create_push_token_change_request('50000000-0000-4000-8000-000000000009', lpad('9', 64, '0'), 'test-token-x', repeat('A', 43), repeat('B', 43))$$,
  '42501', null, 'anon cannot start a token change'
);
select throws_ok(
  $$select count(*) from private.push_device_registrations$$,
  '42501', null, 'anon cannot read the registrations directly'
);

reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000d0b03","role":"authenticated"}', true);
set local role authenticated;

select throws_ok(
  $$select * from public.renew_push_registration('50000000-0000-4000-8000-000000000009', lpad('9', 64, '0'), 'test-token-u09', '2', true, true)$$,
  '42501', null, 'authenticated cannot renew'
);
select throws_ok(
  $$select * from public.disable_push_registration('50000000-0000-4000-8000-000000000009', lpad('9', 64, '0'))$$,
  '42501', null, 'authenticated cannot disable'
);
select throws_ok(
  $$select * from public.create_push_token_change_request('50000000-0000-4000-8000-000000000009', lpad('9', 64, '0'), 'test-token-x', repeat('A', 43), repeat('B', 43))$$,
  '42501', null, 'authenticated cannot start a token change'
);
select throws_ok(
  $$select * from public.confirm_push_token_change('51000000-0000-4000-8000-0000000000fe', lpad('1', 64, '0'), repeat('A', 43), repeat('B', 43))$$,
  '42501', null, 'authenticated cannot confirm a token change'
);

reset role;

select * from finish();

rollback;
