-- decide_moderation_case: one transaction, prior state returned, one event.
begin;
select plan(28);

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

-- Case three: content ten is held with three open reports.
select is(
  (select count(*) from public.moderation_events where case_id = '60000000-0000-4000-8000-000000000003'),
  0::bigint, 'case three starts with no events');

select results_eq(
  $$ select case_id, decision, moderation_state, prior_state, reports_resolved
       from public.decide_moderation_case('60000000-0000-4000-8000-000000000003', 'remove', true,
                                           '10000000-0000-4000-8000-000000000001', 'moderator', 'Targets a group') $$,
  $$ values ('60000000-0000-4000-8000-000000000003'::uuid, 'remove', 'removed', 'held', 3) $$,
  'remove returns the prior state and the number of reports resolved');

select is((select moderation_state from public.moderation_content where id = '30000000-0000-4000-8000-000000000010'), 'removed', 'content is removed');
select is((select count(*) from public.moderation_reports where case_id = '60000000-0000-4000-8000-000000000003' and state = 'upheld' and resolved_at is not null), 3::bigint, 'open reports resolve to upheld');
select results_eq(
  $$ select state, decision, decided_at is not null from public.moderation_cases where id = '60000000-0000-4000-8000-000000000003' $$,
  $$ values ('decided', 'remove', true) $$,
  'case closes as decided with the decision');
select results_eq(
  $$ select event_type, source, severity, summary, prior_state, actor_id, target_id, details
       from public.moderation_events where case_id = '60000000-0000-4000-8000-000000000003' $$,
  $$ values ('content_remove', 'moderator', 'violation', 'Targets a group', 'held',
             '10000000-0000-4000-8000-000000000001'::uuid, '30000000-0000-4000-8000-000000000010'::uuid,
             '{"decision": "remove", "flag_justified": true}'::jsonb) $$,
  'exactly one event is written, carrying p_source');

select throws_ok(
  $$ select * from public.decide_moderation_case('60000000-0000-4000-8000-000000000003', 'keep', null, '10000000-0000-4000-8000-000000000001', 'moderator', null) $$,
  'MQ013', 'case_not_open', 'a decided case refuses keep');
select throws_ok(
  $$ select * from public.decide_moderation_case('60000000-0000-4000-8000-000000000003', 'remove', true, '10000000-0000-4000-8000-000000000001', 'moderator', null) $$,
  'MQ013', 'case_not_open', 'a decided case refuses remove');

-- Restore moves a decided case to reversed.
select results_eq(
  $$ select decision, moderation_state, prior_state, reports_resolved
       from public.decide_moderation_case('60000000-0000-4000-8000-000000000003', 'restore', null,
                                           '10000000-0000-4000-8000-000000000002', 'admin', 'Appeal overturned') $$,
  $$ values ('restore', 'visible', 'removed', 0) $$,
  'restore returns the removed prior state');
select is((select state from public.moderation_cases where id = '60000000-0000-4000-8000-000000000003'), 'reversed', 'restore sets the case to reversed');
select is((select moderation_state from public.moderation_content where id = '30000000-0000-4000-8000-000000000010'), 'visible', 'restore makes the content visible');
select is((select count(*) from public.moderation_events where case_id = '60000000-0000-4000-8000-000000000003' and event_type = 'content_restore' and source = 'admin'), 1::bigint, 'restore writes one content_restore event');
select throws_ok(
  $$ select * from public.decide_moderation_case('60000000-0000-4000-8000-000000000003', 'restore', null, '10000000-0000-4000-8000-000000000002', 'admin', null) $$,
  'MQ013', 'case_not_open', 'a reversed case refuses every decision');

-- Restore needs a remove ruling, the latest case for the target and removed content.
select throws_ok(
  $$ select * from public.decide_moderation_case('60000000-0000-4000-8000-000000000006', 'restore', null, '10000000-0000-4000-8000-000000000002', 'admin', null) $$,
  'MQ013', 'case_not_open', 'restore on a keep ruling: case_not_open');
insert into public.moderation_cases (id, target_id, state, decided_at, decision, created_at) values
  ('60000000-0000-4000-8000-0000000000bb', '30000000-0000-4000-8000-000000000007', 'decided', now() - interval '2 days', 'remove', now() - interval '2 days'),
  ('60000000-0000-4000-8000-0000000000cc', '30000000-0000-4000-8000-000000000007', 'decided', now() - interval '1 hour', 'remove', now() - interval '1 hour');
update public.moderation_content set moderation_state = 'removed' where id = '30000000-0000-4000-8000-000000000007';
select throws_ok(
  $$ select * from public.decide_moderation_case('60000000-0000-4000-8000-0000000000bb', 'restore', null, '10000000-0000-4000-8000-000000000002', 'admin', null) $$,
  'MQ013', 'case_not_open', 'restore through an earlier case while a later case exists: case_not_open');
select lives_ok(
  $$ select * from public.decide_moderation_case('60000000-0000-4000-8000-0000000000cc', 'restore', null, '10000000-0000-4000-8000-000000000002', 'admin', null) $$,
  'restore through the latest remove ruling is accepted');
update public.moderation_content set moderation_state = 'visible' where id = '30000000-0000-4000-8000-000000000012';
select throws_ok(
  $$ select * from public.decide_moderation_case('60000000-0000-4000-8000-000000000005', 'restore', null, '10000000-0000-4000-8000-000000000002', 'admin', null) $$,
  'MQ013', 'case_not_open', 'restore when the content is no longer removed: case_not_open');

-- Dismiss: keep with flag_justified false rejects the reports.
select results_eq(
  $$ select decision, moderation_state, prior_state, reports_resolved
       from public.decide_moderation_case('60000000-0000-4000-8000-000000000002', 'keep', false,
                                           '10000000-0000-4000-8000-000000000001', 'moderator', null) $$,
  $$ values ('keep', 'visible', 'held', 1) $$,
  'keep on a claimed case returns held as the prior state');
select is((select state from public.moderation_reports where id = '50000000-0000-4000-8000-000000000007'), 'rejected', 'flag_justified false rejects the open report');
select is((select count(*) from public.moderation_events where case_id = '60000000-0000-4000-8000-000000000002' and event_type = 'content_approve' and severity = 'info'), 1::bigint, 'keep writes one content_approve event');
select is((select count(*) from public.moderation_events where case_id = '60000000-0000-4000-8000-000000000002'), 2::bigint, 'the earlier content_hold event is untouched');

-- Approve: keep with flag_justified null rejects, like dismiss; only true upholds.
insert into public.moderation_reports (id, case_id, target_id, reporter_id, trust_weight)
values ('50000000-0000-4000-8000-0000000000aa', '60000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000008', '20000000-0000-4000-8000-000000000001', 1.0);
select lives_ok(
  $$ select * from public.decide_moderation_case('60000000-0000-4000-8000-000000000001', 'keep', null, null, 'automated', null) $$,
  'keep with a null actor and the automated source is accepted');
select is((select state from public.moderation_reports where id = '50000000-0000-4000-8000-0000000000aa'), 'rejected', 'flag_justified null resolves the open report to rejected');
select is((select details->'flag_justified' from public.moderation_events where case_id = '60000000-0000-4000-8000-000000000001' and event_type = 'content_approve'), 'null'::jsonb, 'details record the null flag_justified');

-- Input guards.
select throws_ok(
  $$ select * from public.decide_moderation_case('60000000-0000-4000-8000-0000000000ff', 'keep', null, null, 'system', null) $$,
  'MQ003', 'not_found', 'unknown case: not_found');
select throws_ok(
  $$ select * from public.decide_moderation_case('60000000-0000-4000-8000-000000000006', 'restore', null, null, 'bogus', null) $$,
  'MQ004', 'invalid_input', 'unknown source: invalid_input');
insert into public.moderation_cases (id, target_id) values ('60000000-0000-4000-8000-0000000000aa', '30000000-0000-4000-8000-000000000001');
select throws_ok(
  $$ select * from public.decide_moderation_case('60000000-0000-4000-8000-0000000000aa', 'dismiss', null, null, 'system', null) $$,
  'MQ004', 'invalid_input', 'unknown decision: invalid_input');
select is((select state from public.moderation_cases where id = '60000000-0000-4000-8000-0000000000aa'), 'open', 'a refused decision changes nothing');

select * from finish();
rollback;
