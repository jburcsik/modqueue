-- file_appeal (client) and file_appeal_for (service): every guard, in order.
begin;
select plan(13);

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

select pg_temp.act_as('authenticated', null);
select throws_ok(
  'select public.file_appeal(''40000000-0000-4000-8000-000000000003'', ''a statement of ten or more'')',
  'MQ001', 'unauthenticated', 'no jwt: unauthenticated');

-- member4 tries to appeal member3's strike.
select pg_temp.act_as('authenticated', '20000000-0000-4000-8000-000000000004');
select throws_ok(
  'select public.file_appeal(''40000000-0000-4000-8000-000000000003'', ''a statement of ten or more'')',
  'MQ010', 'not_strike_owner', 'forged appeal on another member''s strike: not_strike_owner');
select throws_ok(
  'select public.file_appeal(''40000000-0000-4000-8000-0000000000ff'', ''a statement of ten or more'')',
  'MQ003', 'not_found', 'unknown strike: not_found');

-- member1's strike has expired; member6's was revoked.
select pg_temp.act_as('authenticated', '20000000-0000-4000-8000-000000000001');
select throws_ok(
  'select public.file_appeal(''40000000-0000-4000-8000-000000000001'', ''a statement of ten or more'')',
  'MQ011', 'strike_inactive', 'expired strike: strike_inactive');
select pg_temp.act_as('authenticated', '20000000-0000-4000-8000-000000000006');
select throws_ok(
  'select public.file_appeal(''40000000-0000-4000-8000-000000000009'', ''a statement of ten or more'')',
  'MQ011', 'strike_inactive', 'revoked strike: strike_inactive');

-- member2 already has a pending appeal on strike two.
select pg_temp.act_as('authenticated', '20000000-0000-4000-8000-000000000002');
select throws_ok(
  'select public.file_appeal(''40000000-0000-4000-8000-000000000002'', ''a statement of ten or more'')',
  'MQ009', 'duplicate_appeal', 'pending appeal exists: duplicate_appeal');

-- member3 has two active strikes and no appeal.
select pg_temp.act_as('authenticated', '20000000-0000-4000-8000-000000000003');
select throws_ok(
  'select public.file_appeal(''40000000-0000-4000-8000-000000000003'', ''too short'')',
  'MQ004', 'invalid_input', 'statement under ten characters: invalid_input');
select throws_ok(
  'select public.file_appeal(''40000000-0000-4000-8000-000000000003'', repeat(''x'', 1001))',
  'MQ004', 'invalid_input', 'statement over one thousand characters: invalid_input');
select lives_ok(
  'select public.file_appeal(''40000000-0000-4000-8000-000000000003'', ''The reply was a quote of the other post, not my words.'')',
  'a valid appeal is accepted');
select is(
  (select count(*) from public.moderation_appeals where strike_id = '40000000-0000-4000-8000-000000000003' and state = 'pending'),
  1::bigint, 'the member can read the appeal just filed');

select pg_temp.act_as('service_role', null);
select is(
  (select count(*) from public.moderation_events
    where event_type = 'appeal_filed'
      and target_type = 'user'
      and target_id = '20000000-0000-4000-8000-000000000003'
      and source = 'member'
      and actor_id = '20000000-0000-4000-8000-000000000003'
      and (details->>'strike_id')::uuid = '40000000-0000-4000-8000-000000000003'),
  1::bigint, 'one appeal_filed event names the appellant and the strike');

-- Rate limit: appeal_rate_max is three per window.
insert into internal.rate_limit_entries (key)
select 'appeal:20000000-0000-4000-8000-000000000003' from generate_series(1, 2);
select throws_ok(
  'select public.file_appeal_for(''20000000-0000-4000-8000-000000000003'', ''40000000-0000-4000-8000-000000000004'', ''a statement of ten or more'')',
  'MQ005', 'rate_limited', 'fourth appeal inside the window: rate_limited');

-- One pending appeal per strike is also an index.
select throws_ok(
  'insert into public.moderation_appeals (user_id, strike_id, statement) values (''20000000-0000-4000-8000-000000000002'', ''40000000-0000-4000-8000-000000000002'', ''a statement of ten or more'')',
  '23505', null, 'a second pending appeal on a strike violates the unique index');

select * from finish();
rollback;
