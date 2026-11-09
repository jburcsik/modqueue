-- purge_report_identities and purge_orphaned_moderation.
begin;
select plan(8);

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

-- Report four resolved 70 days ago, report five 5 days ago; retention is 60.
select is(public.purge_report_identities(), 1, 'one report is past the retention window');
select is((select reporter_id from public.moderation_reports where id = '50000000-0000-4000-8000-000000000004'), null, 'the old report loses its reporter');
select isnt((select reporter_id from public.moderation_reports where id = '50000000-0000-4000-8000-000000000005'), null, 'the recent report keeps its reporter');
select is((select state from public.moderation_reports where id = '50000000-0000-4000-8000-000000000004'), 'upheld', 'the outcome survives the purge');
select is(public.purge_report_identities(), 0, 'a second run finds nothing');

-- Orphans: delete content eleven and its reports and case lose their target.
delete from public.moderation_content where id = '30000000-0000-4000-8000-000000000011';
select results_eq(
  $$ select reports_purged, cases_purged from public.purge_orphaned_moderation() $$,
  $$ values (2, 1) $$,
  'reports and cases whose content is gone are deleted');
select is((select count(*) from public.moderation_cases where id = '60000000-0000-4000-8000-000000000004'), 0::bigint, 'the orphaned case is gone');
select is((select case_id from public.moderation_events where id = '80000000-0000-4000-8000-000000000003'), null, 'the event keeps its row with case_id set null');

select * from finish();
rollback;
