-- Strike points, expiry, revocation, the client count, and the sweep.
begin;
select plan(17);

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

select pg_temp.act_as('service_role', null);

-- Ladder tiers from the seed.
select is(public.get_active_strike_points('20000000-0000-4000-8000-000000000001'), 0, 'member1: an expired strike counts nothing');
select is(public.get_active_strike_points('20000000-0000-4000-8000-000000000002'), 2, 'member2: nudge');
select is(public.get_active_strike_points('20000000-0000-4000-8000-000000000003'), 4, 'member3: warned');
select is(public.get_active_strike_points('20000000-0000-4000-8000-000000000004'), 6, 'member4: review gated');
select is(public.get_active_strike_points('20000000-0000-4000-8000-000000000005'), 8, 'member5: quieted, permanent plus expiring');
select is(public.get_active_strike_points('20000000-0000-4000-8000-000000000006'), 0, 'member6: a revoked strike counts nothing');
select is(public.get_active_strike_points('10000000-0000-4000-8000-000000000001'), 0, 'no strikes: zero');

-- Revocation and expiry take effect at once.
update public.user_strikes set revoked_at = now() where id = '40000000-0000-4000-8000-000000000003';
select is(public.get_active_strike_points('20000000-0000-4000-8000-000000000003'), 2, 'revoking one strike drops the points');
update public.user_strikes set expires_at = now() - interval '1 second' where id = '40000000-0000-4000-8000-000000000004';
select is(public.get_active_strike_points('20000000-0000-4000-8000-000000000003'), 0, 'an expiry in the past drops the points');

-- Points are bounded by the CHECK.
select throws_ok(
  $$ insert into public.user_strikes (user_id, severity, points, reason) values ('20000000-0000-4000-8000-000000000001', 'severe', 6, 'x') $$,
  '23514', null, 'points above five are refused');

-- get_my_strike_count: a count of active strikes, never points.
select pg_temp.act_as('authenticated', '20000000-0000-4000-8000-000000000005');
select is(public.get_my_strike_count(), 2, 'member5 sees two active strikes, not eight points');
select pg_temp.act_as('authenticated', '20000000-0000-4000-8000-000000000001');
select is(public.get_my_strike_count(), 0, 'member1 sees zero: the expired strike is not counted');
select pg_temp.act_as('authenticated', '20000000-0000-4000-8000-000000000006');
select is(public.get_my_strike_count(), 0, 'member6 sees zero: the revoked strike is not counted');

-- The sweep: content eight is tier held (release below six points) and
-- content nine is moderator held. Member4 is at six points.
select pg_temp.act_as('service_role', null);
select is(public.sweep_expired_strikes(), 0, 'at six points nothing is released');

update public.user_strikes set expires_at = now() - interval '1 second' where id = '40000000-0000-4000-8000-000000000006';
select is(public.sweep_expired_strikes(), 1, 'below six points the tier held content is released');
select results_eq(
  $$ select mc.moderation_state, c.state, c.decision
       from public.moderation_content mc join public.moderation_cases c on c.target_id = mc.id
      where mc.id = '30000000-0000-4000-8000-000000000008' $$,
  $$ values ('visible', 'decided', 'keep') $$,
  'the released content is visible and its case is decided keep');
select results_eq(
  $$ select event_type, source, prior_state from public.moderation_events
      where case_id = '60000000-0000-4000-8000-000000000001' and event_type <> 'tier_hold' $$,
  $$ values ('content_approve', 'system', 'held') $$,
  'one content_approve event records the release');

select * from finish();
rollback;
