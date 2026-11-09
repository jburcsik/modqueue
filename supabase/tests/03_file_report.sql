-- file_report (client) and file_report_for (service): every guard, in order.
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

create function pg_temp.act_as(p_role text, p_uid uuid) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    case when p_uid is null then ''
         else json_build_object('sub', p_uid, 'role', p_role)::text end, true);
  perform set_config('role', p_role, true);
end;
$$;

-- member1 (200 days old) reports member3's visible content.
select pg_temp.act_as('authenticated', null);
select throws_ok(
  'select public.file_report(''30000000-0000-4000-8000-000000000005'', ''reason'', ''{}'')',
  'MQ001', 'unauthenticated', 'no jwt: unauthenticated');

select pg_temp.act_as('authenticated', '20000000-0000-4000-8000-000000000006');
select throws_ok(
  'select public.file_report(''30000000-0000-4000-8000-000000000005'', ''reason'', ''{}'')',
  'MQ006', 'account_too_new', 'member6 (twelve hours old): account_too_new');

select pg_temp.act_as('authenticated', '20000000-0000-4000-8000-000000000001');
select throws_ok(
  'select public.file_report(''30000000-0000-4000-8000-000000000001'', ''reason'', ''{}'')',
  'MQ007', 'self_report', 'own content: self_report');
select throws_ok(
  'select public.file_report(''30000000-0000-4000-8000-0000000000ff'', ''reason'', ''{}'')',
  'MQ003', 'not_found', 'unknown target: not_found');
select throws_ok(
  'select public.file_report(''30000000-0000-4000-8000-000000000008'', ''reason'', ''{}'')',
  'MQ003', 'not_found', 'held target of another member: not_found');
select throws_ok(
  'select public.file_report(''30000000-0000-4000-8000-000000000012'', ''reason'', ''{}'')',
  'MQ003', 'not_found', 'removed target: not_found');
select throws_ok(
  'select public.file_report(''30000000-0000-4000-8000-000000000005'', ''reason'', ''{"../etc/passwd"}'')',
  'MQ004', 'invalid_input', 'path outside the allowed shape: invalid_input');
select throws_ok(
  'select public.file_report(''30000000-0000-4000-8000-000000000005'', ''reason'', ''{"evidence/../x"}'')',
  'MQ004', 'invalid_input', 'dot-dot segment inside the path: invalid_input');
select throws_ok(
  'select public.file_report(''30000000-0000-4000-8000-000000000005'', ''reason'', ''{"a//b"}'')',
  'MQ004', 'invalid_input', 'empty segment: invalid_input');
select throws_ok(
  'select public.file_report(''30000000-0000-4000-8000-000000000005'', ''reason'', ''{"a/"}'')',
  'MQ004', 'invalid_input', 'trailing slash: invalid_input');
select throws_ok(
  'select public.file_report(''30000000-0000-4000-8000-000000000005'', ''reason'', ''{"/a"}'')',
  'MQ004', 'invalid_input', 'leading slash: invalid_input');
select throws_ok(
  'select public.file_report(''30000000-0000-4000-8000-000000000005'', ''reason'', ''{"./a"}'')',
  'MQ004', 'invalid_input', 'dot segment: invalid_input');
select throws_ok(
  'select public.file_report(''30000000-0000-4000-8000-000000000005'', ''reason'', ''{"a.png","b.png","c.png"}'')',
  'MQ004', 'invalid_input', 'three evidence paths: invalid_input');
select throws_ok(
  'select public.file_report(''30000000-0000-4000-8000-000000000005'', repeat(''x'', 501), ''{}'')',
  'MQ004', 'invalid_input', 'reason over the limit: invalid_input');

select lives_ok(
  'select public.file_report(''30000000-0000-4000-8000-000000000005'', ''Lost pet post is a scam'', ''{"evidence/one.png","evidence/two.jpg"}'')',
  'a valid report is accepted');
select throws_ok(
  'select public.file_report(''30000000-0000-4000-8000-000000000005'', ''again'', ''{}'')',
  'MQ008', 'duplicate_report', 'second open report on the same target: duplicate_report');

-- Server-side effects, read as the service role.
select pg_temp.act_as('service_role', null);
select is(
  (select trust_weight from public.moderation_reports
    where reporter_id = '20000000-0000-4000-8000-000000000001'
      and target_id = '30000000-0000-4000-8000-000000000005'),
  (select round(rc.coefficient, 4) from public.calculate_reach_coefficient('20000000-0000-4000-8000-000000000001') rc),
  'trust_weight equals the reporter''s reach coefficient');
select is(
  (select state from public.moderation_cases where target_id = '30000000-0000-4000-8000-000000000005'),
  'open', 'a report on content with no open case opens one');
select is(
  (select r.case_id from public.moderation_reports r
    where r.reporter_id = '20000000-0000-4000-8000-000000000001'
      and r.target_id = '30000000-0000-4000-8000-000000000005'),
  (select id from public.moderation_cases where target_id = '30000000-0000-4000-8000-000000000005'),
  'the report carries the open case id');
select is(
  (select moderation_state from public.moderation_content where id = '30000000-0000-4000-8000-000000000005'),
  'visible', 'one report below auto_hide_weight leaves the content visible');

-- Rate limit: the fifth report in the window is the last allowed.
select is(
  (select count(*) from internal.rate_limit_entries where key = 'report:20000000-0000-4000-8000-000000000001'),
  1::bigint, 'an accepted report consumes one rate limit slot');
insert into internal.rate_limit_entries (key)
select 'report:20000000-0000-4000-8000-000000000001' from generate_series(1, 4);
select throws_ok(
  'select public.file_report_for(''20000000-0000-4000-8000-000000000001'', ''30000000-0000-4000-8000-000000000006'', null, null)',
  'MQ005', 'rate_limited', 'sixth report inside the window: rate_limited');

-- Trust-weighted auto hide: three low-weight reports do not hide; weight at
-- the threshold does.
update public.moderation_settings set reach_enabled = false;
insert into public.moderation_reports (target_id, reporter_id, trust_weight, state)
values ('30000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000004', 0.3, 'open'),
       ('30000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000005', 0.3, 'open');
select lives_ok(
  'select public.file_report_for(''20000000-0000-4000-8000-000000000002'', ''30000000-0000-4000-8000-000000000006'', null, null)',
  'service path accepts a report with reach disabled');
select is(
  (select trust_weight from public.moderation_reports
    where reporter_id = '20000000-0000-4000-8000-000000000002'
      and target_id = '30000000-0000-4000-8000-000000000006'),
  1.0::numeric, 'with reach disabled the report carries trust weight 1.0');
select is(
  (select moderation_state from public.moderation_content where id = '30000000-0000-4000-8000-000000000006'),
  'visible', 'open weight 1.6 is below auto_hide_weight 3.5: still visible');
update public.moderation_reports set trust_weight = 1.5
 where target_id = '30000000-0000-4000-8000-000000000006' and trust_weight = 0.3;
select lives_ok(
  'select public.file_report_for(''10000000-0000-4000-8000-000000000001'', ''30000000-0000-4000-8000-000000000006'', null, null)',
  'a further report is accepted');
select is(
  (select moderation_state from public.moderation_content where id = '30000000-0000-4000-8000-000000000006'),
  'held', 'open weight 5.0 at or above auto_hide_weight: held');
select results_eq(
  $$ select e.source, e.severity, e.prior_state, e.details,
            e.case_id = (select c.id from public.moderation_cases c where c.target_id = e.target_id and c.state = 'open')
       from public.moderation_events e
      where e.target_type = 'content' and e.target_id = '30000000-0000-4000-8000-000000000006' and e.event_type = 'content_hold' $$,
  $$ values ('system', 'warning', 'visible',
             '{"reason": "auto_hide", "weight_sum": 5.0, "threshold": 3.5}'::jsonb, true) $$,
  'the auto hide writes exactly one content_hold event from system on the open case');

select * from finish();
rollback;
