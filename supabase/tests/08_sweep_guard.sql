-- The sweep never releases content held by a moderator or by automation.
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

-- Remove every strike so every owner is below any threshold.
delete from public.user_strikes;

-- Content nine: moderator hold, one open report. Resolve the report so the
-- only thing keeping it held is the content_hold event.
update public.moderation_reports set state = 'withdrawn', resolved_at = now() where case_id = '60000000-0000-4000-8000-000000000002';
update public.moderation_cases set state = 'open', claimed_by = null, claimed_at = null where id = '60000000-0000-4000-8000-000000000002';

-- Content ten: open reports and no events at all.
-- Content eight: tier hold only.
select is(public.sweep_expired_strikes(), 1, 'only the tier held content is released');
select is((select moderation_state from public.moderation_content where id = '30000000-0000-4000-8000-000000000008'), 'visible', 'tier held content eight is released');
select is((select moderation_state from public.moderation_content where id = '30000000-0000-4000-8000-000000000009'), 'held', 'moderator held content nine stays held');
select is((select moderation_state from public.moderation_content where id = '30000000-0000-4000-8000-000000000010'), 'held', 'content with open reports stays held');

-- A tier hold followed by a moderator hold on the same case stays held.
insert into public.moderation_content (id, owner_id, moderation_state) values ('30000000-0000-4000-8000-0000000000aa', '20000000-0000-4000-8000-000000000001', 'held');
insert into public.moderation_events (target_type, target_id, case_id, event_type, source, severity, details)
select 'content', '30000000-0000-4000-8000-0000000000aa', c.id, 'tier_hold', 'system', 'info', '{"release_below_points": 6}'
  from public.moderation_cases c where c.target_id = '30000000-0000-4000-8000-0000000000aa';
insert into public.moderation_events (target_type, target_id, case_id, event_type, source, severity)
select 'content', '30000000-0000-4000-8000-0000000000aa', c.id, 'content_hold', 'automated', 'warning'
  from public.moderation_cases c where c.target_id = '30000000-0000-4000-8000-0000000000aa';
select is(public.sweep_expired_strikes(), 0, 'a case with a tier hold and an automated hold is not released');

-- A tier hold without release_below_points is never released.
insert into public.moderation_content (id, owner_id, moderation_state) values ('30000000-0000-4000-8000-0000000000bb', '20000000-0000-4000-8000-000000000001', 'held');
insert into public.moderation_events (target_type, target_id, case_id, event_type, source, severity)
select 'content', '30000000-0000-4000-8000-0000000000bb', c.id, 'tier_hold', 'system', 'info'
  from public.moderation_cases c where c.target_id = '30000000-0000-4000-8000-0000000000bb';
select is(public.sweep_expired_strikes(), 0, 'a tier hold without release_below_points is not released');

-- A tier hold whose release_below_points is not an integer is skipped without aborting the sweep.
insert into public.moderation_content (id, owner_id, moderation_state) values ('30000000-0000-4000-8000-0000000000cc', '20000000-0000-4000-8000-000000000001', 'held');
insert into public.moderation_events (target_type, target_id, case_id, event_type, source, severity, details)
select 'content', '30000000-0000-4000-8000-0000000000cc', c.id, 'tier_hold', 'system', 'info', '{"release_below_points": "six"}'
  from public.moderation_cases c where c.target_id = '30000000-0000-4000-8000-0000000000cc';
select is(public.sweep_expired_strikes(), 0, 'a malformed release_below_points is skipped and the sweep completes');

select * from finish();
rollback;
