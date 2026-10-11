-- pgTAP tests for public.current_user_is_admin().
-- Everything runs inside one transaction and is rolled back.

begin;

create extension if not exists pgtap with schema extensions;

select plan(16);

insert into auth.users (id, email, aud, role)
values
  ('00000000-0000-4000-8000-00000000c001', 'check-admin@example.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-00000000d001', 'check-user@example.invalid', 'authenticated', 'authenticated');

insert into public.admin_users (user_id)
values ('00000000-0000-4000-8000-00000000c001');

-- ============================================================
-- Structure
-- ============================================================

select has_function('public', 'current_user_is_admin', array[]::text[],
  'current_user_is_admin() exists with no arguments');
select function_returns('public', 'current_user_is_admin', array[]::text[], 'boolean',
  'current_user_is_admin() returns boolean');
select is(
  (select prosecdef from pg_proc where oid = 'public.current_user_is_admin()'::regprocedure),
  false, 'current_user_is_admin() is SECURITY INVOKER'
);
select ok(
  (select proconfig @> array['search_path=""'] from pg_proc
   where oid = 'public.current_user_is_admin()'::regprocedure),
  'current_user_is_admin() pins search_path to empty'
);
select is(
  (select provolatile from pg_proc where oid = 'public.current_user_is_admin()'::regprocedure),
  's'::"char", 'current_user_is_admin() is STABLE'
);
select ok(
  not has_function_privilege('anon', 'public.current_user_is_admin()', 'execute'),
  'anon has no EXECUTE on current_user_is_admin()'
);
select ok(
  not exists (
    select 1
    from pg_proc p, aclexplode(p.proacl) a
    where p.oid = 'public.current_user_is_admin()'::regprocedure
      and a.grantee = 0 and a.privilege_type = 'EXECUTE'
  ),
  'PUBLIC has no EXECUTE on current_user_is_admin()'
);
select ok(
  has_function_privilege('authenticated', 'public.current_user_is_admin()', 'execute'),
  'authenticated has EXECUTE on current_user_is_admin()'
);

-- ============================================================
-- anon
-- ============================================================

select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;

select throws_ok('select public.current_user_is_admin()', '42501', null,
  'anon: current_user_is_admin() is denied');
select throws_ok('select private.is_admin()', '42501', null,
  'anon: private.is_admin() is denied');

reset role;

-- ============================================================
-- authenticated without a user id (no sub claim)
-- ============================================================

select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
set local role authenticated;

select is(public.current_user_is_admin(), false,
  'authenticated without sub: current_user_is_admin() is false');

reset role;

-- ============================================================
-- authenticated non-admin
-- ============================================================

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000d001","role":"authenticated"}', true);
set local role authenticated;

select is(public.current_user_is_admin(), false,
  'non-admin: current_user_is_admin() is false');
select throws_ok('select * from public.admin_users', '42501', null,
  'non-admin: admin_users is still unreadable');

reset role;

-- ============================================================
-- authenticated admin
-- ============================================================

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000c001","role":"authenticated"}', true);
set local role authenticated;

select is(public.current_user_is_admin(), true,
  'admin: current_user_is_admin() is true');
select throws_ok('select * from public.admin_users', '42501', null,
  'admin: admin_users is still unreadable');
select is(
  pg_typeof(public.current_user_is_admin())::text, 'boolean',
  'admin: the result is a plain boolean (no row or id)'
);

reset role;

select * from finish();

rollback;
