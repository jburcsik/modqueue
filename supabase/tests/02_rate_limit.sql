-- check_rate_limit: sliding window over internal.rate_limit_entries.
begin;
select plan(9);

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

select is(public.check_rate_limit('test:a', 60, 3), true,  'first call within max is allowed');
select is(public.check_rate_limit('test:a', 60, 3), true,  'second call within max is allowed');
select is(public.check_rate_limit('test:a', 60, 3), true,  'third call reaches max and is allowed');
select is(public.check_rate_limit('test:a', 60, 3), false, 'fourth call at max is denied');
select is((select count(*) from internal.rate_limit_entries where key = 'test:a'), 3::bigint, 'a denied call writes no row');

-- Entries older than the window no longer count and are cleaned up.
insert into internal.rate_limit_entries (key, created_at)
values ('test:b', now() - interval '90 seconds'),
       ('test:b', now() - interval '80 seconds'),
       ('test:b', now() - interval '70 seconds');
select is(public.check_rate_limit('test:b', 60, 3), true, 'entries outside the window do not count');
select is((select count(*) from internal.rate_limit_entries where key = 'test:b'), 1::bigint, 'expired entries for the key are deleted on an allowed call');
select is((select count(*) from internal.rate_limit_entries where key = 'test:a'), 3::bigint, 'cleanup touches only the checked key');

-- Keys are independent.
select is(public.check_rate_limit('test:c', 60, 1), true, 'a fresh key starts empty');

select * from finish();
rollback;
