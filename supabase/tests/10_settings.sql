-- moderation_settings: the seeded row equals defaultConfig.settings, the
-- full_auto acknowledgement CHECK holds, and clients cannot read it.
begin;
select plan(7);

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

select is((select count(*) from public.moderation_settings), 1::bigint, 'exactly one settings row');

select results_eq(
  $$ select id, automation_level, warn_threshold, hold_threshold, auto_action_confidence,
            auto_warn_keywords, auto_block_keywords, full_auto_acknowledged_at,
            auto_hide_weight, report_min_account_age_hours,
            report_rate_max, report_rate_window_seconds,
            appeal_rate_max, appeal_rate_window_seconds,
            report_identity_retention_days, reach_enabled
       from public.moderation_settings $$,
  $$ values ('default', 'assist', 0.5::numeric, 0.8::numeric, 0.75::numeric,
             '{}'::text[], '{}'::text[], null::timestamptz,
             3.5::numeric, 48, 5, 3600, 3, 86400, 60, true) $$,
  'the column defaults equal defaultConfig.settings');

select throws_ok(
  $$ update public.moderation_settings set automation_level = 'full_auto' $$,
  '23514', null, 'full_auto without an acknowledgement is refused');
select lives_ok(
  $$ update public.moderation_settings set automation_level = 'full_auto', full_auto_acknowledged_at = now() $$,
  'full_auto with an acknowledgement is accepted');
select throws_ok(
  $$ update public.moderation_settings set full_auto_acknowledged_at = null $$,
  '23514', null, 'clearing the acknowledgement while full_auto is refused');
select throws_ok(
  $$ insert into public.moderation_settings (id) values ('second') $$,
  '23514', null, 'a second settings row is refused');

set local request.jwt.claims = '{"sub": "20000000-0000-4000-8000-000000000001", "role": "authenticated"}';
set local role authenticated;
select throws_ok('select automation_level from public.moderation_settings', '42501', null, 'authenticated cannot read settings');

select * from finish();
rollback;
