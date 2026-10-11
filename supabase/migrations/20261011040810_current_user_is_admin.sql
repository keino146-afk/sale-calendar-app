-- Lets a signed-in user ask one question: "am I an admin?" (boolean only).
--
-- SECURITY INVOKER on purpose: the function runs with the caller's own
-- privileges and adds no new definer surface. Its only privileged step is
-- private.is_admin(), which is already SECURITY DEFINER, pinned to
-- search_path = '' and executable by authenticated only (anon has neither
-- EXECUTE on it nor USAGE on schema private). admin_users stays unreadable,
-- and no user id or row is ever returned.

create function public.current_user_is_admin()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select private.is_admin();
$$;

revoke all on function public.current_user_is_admin() from public, anon;
grant execute on function public.current_user_is_admin() to authenticated;
