-- The two probes: every definer function pins search_path, and exactly four
-- definer functions are callable by clients.
begin;
select plan(6);

-- Pin the settings row to its column defaults for this transaction, so the
-- assertions do not depend on what another test or app left in the row.
update public.moderation_settings set
  automation_level = default, warn_threshold = default, hold_threshold = default,
  auto_action_confidence = default, auto_warn_keywords = default, auto_block_keywords = default,
  full_auto_acknowledged_at = default, auto_hide_weight = default,
  report_min_account_age_hours = default, report_rate_max = default,
  report_rate_window_seconds = default, appeal_rate_max = default,
  appeal_rate_window_seconds = default, report_identity_retention_days = default,
  reach_enabled = default
where id = 'default';

set local role service_role;

select is_empty(
  $$ select * from public.security_definer_functions_without_search_path() $$,
  'no SECURITY DEFINER function in public or internal lacks a pinned search_path');

select results_eq(
  $$ select function_name, arguments, anon, authenticated from public.client_callable_definer_functions() $$,
  $$ values ('file_appeal', 'p_strike_id uuid, p_statement text', false, true),
            ('file_report', 'p_target_id uuid, p_reason text, p_evidence_paths text[]', false, true),
            ('get_my_role', '', false, true),
            ('get_my_strike_count', '', false, true) $$,
  'exactly the four client callable functions, authenticated only');

-- The probe still sees an unpinned or client callable function when one appears.
reset role;
create function public.probe_canary() returns integer language sql security definer as $$ select 1 $$;
set local role service_role;
select results_eq(
  $$ select function_name from public.security_definer_functions_without_search_path() $$,
  $$ values ('probe_canary') $$,
  'the search_path probe reports a new unpinned definer function');
select is(
  (select count(*) from public.client_callable_definer_functions() where function_name = 'probe_canary'),
  1::bigint, 'the EXECUTE probe reports a new definer function that inherits client EXECUTE');
reset role;
revoke execute on function public.probe_canary() from public, anon, authenticated;
alter function public.probe_canary() set search_path = '';
set local role service_role;
select is_empty(
  $$ select * from public.security_definer_functions_without_search_path() $$,
  'pinning search_path clears the search_path probe');
select is(
  (select count(*) from public.client_callable_definer_functions() where function_name = 'probe_canary'),
  0::bigint, 'revoking EXECUTE clears the EXECUTE probe');

select * from finish();
rollback;
