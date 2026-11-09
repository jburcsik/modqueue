-- Grants: one allow and one deny test per table per role.
-- Roles: anon, authenticated member, authenticated moderator, authenticated
-- admin, service_role. Moderators and admins have no direct grants; their
-- role row is read by the server.
begin;
select plan(166);

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

-- A member's content that other members may not see.
insert into public.moderation_content (id, owner_id, moderation_state, body)
values ('30000000-0000-4000-8000-0000000000aa', '20000000-0000-4000-8000-000000000001', 'held', 'own held row');

-- ---------------------------------------------------------------------------
-- anon: nothing
-- ---------------------------------------------------------------------------
select pg_temp.act_as('anon', null);

select throws_ok('select * from public.moderation_roles', '42501', null, 'anon: roles select denied');
select throws_ok('insert into public.moderation_roles (user_id, role) values (''20000000-0000-4000-8000-000000000001'', ''admin'')', '42501', null, 'anon: roles insert denied');
select throws_ok('select * from public.moderation_content', '42501', null, 'anon: content select denied');
select throws_ok('insert into public.moderation_content (owner_id) values (''20000000-0000-4000-8000-000000000001'')', '42501', null, 'anon: content insert denied');
select throws_ok('select * from public.moderation_reputation_inputs', '42501', null, 'anon: reputation view select denied');
select throws_ok('select user_id from public.moderation_reputation_inputs where user_id is null', '42501', null, 'anon: reputation view filtered select denied');
select throws_ok('select * from public.moderation_settings', '42501', null, 'anon: settings select denied');
select throws_ok('update public.moderation_settings set warn_threshold = 0.1', '42501', null, 'anon: settings update denied');
select throws_ok('select * from public.moderation_events', '42501', null, 'anon: events select denied');
select throws_ok('insert into public.moderation_events (target_type, target_id, event_type, source, severity) values (''user'', gen_random_uuid(), ''mod_note'', ''member'', ''info'')', '42501', null, 'anon: events insert denied');
select throws_ok('select * from public.user_strikes', '42501', null, 'anon: strikes select denied');
select throws_ok('insert into public.user_strikes (user_id, severity, points, reason) values (''20000000-0000-4000-8000-000000000001'', ''info'', 1, ''x'')', '42501', null, 'anon: strikes insert denied');
select throws_ok('select * from public.moderation_cases', '42501', null, 'anon: cases select denied');
select throws_ok('insert into public.moderation_cases (target_id) values (gen_random_uuid())', '42501', null, 'anon: cases insert denied');
select throws_ok('select * from public.moderation_reports', '42501', null, 'anon: reports select denied');
select throws_ok('insert into public.moderation_reports (target_id, trust_weight) values (gen_random_uuid(), 1)', '42501', null, 'anon: reports insert denied');
select throws_ok('select * from public.moderation_appeals', '42501', null, 'anon: appeals select denied');
select throws_ok('insert into public.moderation_appeals (user_id, strike_id, statement) values (''20000000-0000-4000-8000-000000000002'', ''40000000-0000-4000-8000-000000000002'', ''ten characters here'')', '42501', null, 'anon: appeals insert denied');
select throws_ok('select * from public.moderation_queue', '42501', null, 'anon: queue select denied');
select throws_ok('select case_id from public.moderation_queue where case_id is null', '42501', null, 'anon: queue filtered select denied');
select throws_ok('select * from internal.rate_limit_entries', '42501', null, 'anon: rate limit select denied');
select throws_ok('insert into internal.rate_limit_entries (key) values (''x'')', '42501', null, 'anon: rate limit insert denied');
select throws_ok('select public.get_my_role()', '42501', null, 'anon: get_my_role denied');
select throws_ok('select public.get_active_strike_points(''20000000-0000-4000-8000-000000000001'')', '42501', null, 'anon: service function denied');

-- ---------------------------------------------------------------------------
-- authenticated member, moderator, admin: the same surface
-- ---------------------------------------------------------------------------

create function pg_temp.client_matrix(p_label text, p_uid uuid) returns setof text
language plpgsql as $$
begin
  perform pg_temp.act_as('authenticated', p_uid);

  return next throws_ok('select * from public.moderation_roles', '42501', null, p_label || ': roles select denied');
  return next throws_ok('insert into public.moderation_roles (user_id, role) values (''' || p_uid || ''', ''admin'')', '42501', null, p_label || ': roles insert denied');

  return next lives_ok('select * from public.moderation_content', p_label || ': content select allowed');
  return next is((select count(*) from public.moderation_content where moderation_state <> 'visible' and owner_id <> p_uid), 0::bigint, p_label || ': content not visible and not own is hidden');
  return next ok((select count(*) from public.moderation_content where moderation_state = 'visible') > 0, p_label || ': visible content is readable');
  return next throws_ok('insert into public.moderation_content (owner_id) values (''' || p_uid || ''')', '42501', null, p_label || ': content insert denied');
  return next throws_ok('update public.moderation_content set moderation_state = ''visible''', '42501', null, p_label || ': content update denied');

  return next throws_ok('select * from public.moderation_reputation_inputs', '42501', null, p_label || ': reputation view select denied');
  return next throws_ok('select user_id from public.moderation_reputation_inputs where user_id = ''' || p_uid || '''', '42501', null, p_label || ': reputation view own row denied');

  return next throws_ok('select * from public.moderation_settings', '42501', null, p_label || ': settings select denied');
  return next throws_ok('update public.moderation_settings set warn_threshold = 0.1', '42501', null, p_label || ': settings update denied');

  return next throws_ok('select * from public.moderation_events', '42501', null, p_label || ': events select denied');
  return next throws_ok('insert into public.moderation_events (target_type, target_id, event_type, source, severity, actor_id) values (''user'', ''' || p_uid || ''', ''mod_note'', ''moderator'', ''info'', ''' || p_uid || ''')', '42501', null, p_label || ': events insert denied');

  return next throws_ok('select * from public.user_strikes', '42501', null, p_label || ': strikes select denied');
  return next throws_ok('insert into public.user_strikes (user_id, severity, points, reason) values (''' || p_uid || ''', ''info'', 1, ''x'')', '42501', null, p_label || ': strikes insert denied');

  return next throws_ok('select * from public.moderation_cases', '42501', null, p_label || ': cases select denied');
  return next throws_ok('update public.moderation_cases set claimed_by = ''' || p_uid || '''', '42501', null, p_label || ': cases update denied');

  return next throws_ok('select * from public.moderation_reports', '42501', null, p_label || ': reports select denied');
  return next throws_ok('insert into public.moderation_reports (target_id, reporter_id, trust_weight) values (''30000000-0000-4000-8000-000000000001'', ''' || p_uid || ''', 1.5)', '42501', null, p_label || ': reports direct insert denied');

  return next lives_ok('select id, user_id, strike_id, moderation_event_id, statement, state, created_at, resolved_at from public.moderation_appeals', p_label || ': appeals select of the granted columns allowed');
  return next throws_ok('select reviewer_note from public.moderation_appeals', '42501', null, p_label || ': appeals reviewer_note select denied');
  return next throws_ok('select resolved_by from public.moderation_appeals', '42501', null, p_label || ': appeals resolved_by select denied');
  return next is((select count(*) from public.moderation_appeals where user_id <> p_uid), 0::bigint, p_label || ': appeals of other users are hidden');
  return next throws_ok('insert into public.moderation_appeals (user_id, strike_id, statement) values (''' || p_uid || ''', ''40000000-0000-4000-8000-000000000002'', ''ten characters here'')', '42501', null, p_label || ': appeals direct insert denied');
  return next throws_ok('update public.moderation_appeals set state = ''overturned''', '42501', null, p_label || ': appeals update denied');

  return next throws_ok('select * from public.moderation_queue', '42501', null, p_label || ': queue select denied');
  return next throws_ok('select case_id from public.moderation_queue where case_id is null', '42501', null, p_label || ': queue filtered select denied');

  return next throws_ok('select * from internal.rate_limit_entries', '42501', null, p_label || ': rate limit select denied');
  return next throws_ok('insert into internal.rate_limit_entries (key) values (''x'')', '42501', null, p_label || ': rate limit insert denied');

  return next lives_ok('select public.get_my_role()', p_label || ': get_my_role allowed');
  return next lives_ok('select public.get_my_strike_count()', p_label || ': get_my_strike_count allowed');
  return next throws_ok('select public.get_active_strike_points(''' || p_uid || ''')', '42501', null, p_label || ': get_active_strike_points denied');
  return next throws_ok('select public.decide_moderation_case(''60000000-0000-4000-8000-000000000001'', ''keep'', null, ''' || p_uid || ''', ''moderator'', null)', '42501', null, p_label || ': decide_moderation_case denied');
  return next throws_ok('select public.file_report_for(''' || p_uid || ''', ''30000000-0000-4000-8000-000000000001'', null, ''{}'')', '42501', null, p_label || ': file_report_for denied');
  return next throws_ok('select public.file_appeal_for(''' || p_uid || ''', ''40000000-0000-4000-8000-000000000002'', ''ten characters here'')', '42501', null, p_label || ': file_appeal_for denied');
  return next throws_ok('select public.sweep_expired_strikes()', '42501', null, p_label || ': sweep denied');
  return next throws_ok('select * from public.client_callable_definer_functions()', '42501', null, p_label || ': probe denied');
end;
$$;

select * from pg_temp.client_matrix('member',    '20000000-0000-4000-8000-000000000001');
select pg_temp.act_as('authenticated', '20000000-0000-4000-8000-000000000001');
select is((select count(*) from public.moderation_content where id = '30000000-0000-4000-8000-0000000000aa'), 1::bigint, 'member: own held row is readable');
select is((select count(*) from public.moderation_appeals where user_id = '20000000-0000-4000-8000-000000000002'), 0::bigint, 'member: pending appeal of another member is hidden');
select pg_temp.act_as('authenticated', '20000000-0000-4000-8000-000000000002');
select is((select count(*) from public.moderation_appeals where id = '70000000-0000-4000-8000-000000000001'), 1::bigint, 'member: own pending appeal is readable');
select is(public.get_my_role(), 'member', 'member: get_my_role is member without a roles row');

select * from pg_temp.client_matrix('moderator', '10000000-0000-4000-8000-000000000001');
select pg_temp.act_as('authenticated', '10000000-0000-4000-8000-000000000001');
select is(public.get_my_role(), 'moderator', 'moderator: get_my_role reads the roles row');

select * from pg_temp.client_matrix('admin',     '10000000-0000-4000-8000-000000000002');
select pg_temp.act_as('authenticated', '10000000-0000-4000-8000-000000000002');
select is(public.get_my_role(), 'admin', 'admin: get_my_role reads the roles row');

-- ---------------------------------------------------------------------------
-- service_role: everything
-- ---------------------------------------------------------------------------
select pg_temp.act_as('service_role', null);

select lives_ok('select * from public.moderation_roles', 'service: roles select allowed');
select lives_ok('update public.moderation_roles set display_name = display_name', 'service: roles update allowed');
select lives_ok('select * from public.moderation_content', 'service: content select allowed');
select is((select count(*) from public.moderation_content where id = '30000000-0000-4000-8000-0000000000aa'), 1::bigint, 'service: content select sees the held test row');
select lives_ok('select * from public.moderation_reputation_inputs', 'service: reputation view select allowed');
select ok((select count(*) from public.moderation_reputation_inputs) >= 8, 'service: reputation view has a row per user');
select lives_ok('select * from public.moderation_settings', 'service: settings select allowed');
select lives_ok('update public.moderation_settings set updated_at = now()', 'service: settings update allowed');
select lives_ok('select * from public.moderation_events', 'service: events select allowed');
select lives_ok('insert into public.moderation_events (target_type, target_id, event_type, source, severity) values (''user'', ''20000000-0000-4000-8000-000000000001'', ''mod_note'', ''system'', ''info'')', 'service: events insert allowed');
select lives_ok('select * from public.user_strikes', 'service: strikes select allowed');
select lives_ok('insert into public.user_strikes (user_id, severity, points, reason) values (''20000000-0000-4000-8000-000000000001'', ''info'', 1, ''service test'')', 'service: strikes insert allowed');
select lives_ok('select * from public.moderation_cases', 'service: cases select allowed');
select lives_ok('update public.moderation_cases set claimed_at = claimed_at', 'service: cases update allowed');
select lives_ok('select * from public.moderation_reports', 'service: reports select allowed');
select lives_ok('update public.moderation_reports set reason = reason', 'service: reports update allowed');
select lives_ok('select * from public.moderation_appeals', 'service: appeals select allowed');
select lives_ok('update public.moderation_appeals set reviewer_note = reviewer_note', 'service: appeals update allowed');
select lives_ok('select * from public.moderation_queue', 'service: queue select allowed');
select is((select count(*) from public.moderation_queue where content_id = '30000000-0000-4000-8000-0000000000aa'), 1::bigint, 'service: queue has one row for the held test row');
select lives_ok('select * from internal.rate_limit_entries', 'service: rate limit select allowed');
select lives_ok('insert into internal.rate_limit_entries (key) values (''service:test'')', 'service: rate limit insert allowed');
select lives_ok('select public.get_active_strike_points(''20000000-0000-4000-8000-000000000001'')', 'service: service function allowed');
select lives_ok('select * from public.client_callable_definer_functions()', 'service: probe allowed');
select throws_ok('select public.get_my_role()', 'MQ001', 'unauthenticated', 'service: get_my_role raises without a jwt');

select * from finish();
rollback;
