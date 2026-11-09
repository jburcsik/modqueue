-- calculate_reach_coefficient and get_user_reputation against a fixture view.
-- Expected values are computed by hand from defaultConfig.reach and
-- defaultConfig.reputation in src/config.ts.
begin;
select plan(14);

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

-- Replace the example view with fixture inputs for the eight seeded users.
delete from public.user_strikes;
create table public.reach_fixture (
  user_id uuid, account_created_at timestamptz, posts integer, endorsed_posts integer,
  endorsements_given integer, reports_received integer, far_rate numeric, strike_points integer,
  expected_reputation integer, expected_coefficient numeric
);
insert into public.reach_fixture values
  ('20000000-0000-4000-8000-000000000001', now() - interval '10 hours',    0,  0,  0,  0, null, 0, 40, 0.4),
  ('20000000-0000-4000-8000-000000000002', now() - interval '100 hours',   5,  2,  4,  0, null, 0, 53, 0.6),
  ('20000000-0000-4000-8000-000000000003', now() - interval '200 hours',  12,  8, 20,  0, 0.1,  0, 86, 1.1385),
  ('20000000-0000-4000-8000-000000000004', now() - interval '1000 hours', 20, 10, 30,  0, null, 0, 86, 1.265),
  ('20000000-0000-4000-8000-000000000005', now() - interval '1000 hours',  3,  0,  0,  3, null, 2, 31, 0.3825),
  ('20000000-0000-4000-8000-000000000006', now() - interval '1000 hours', 10,  9,  2,  4, 0.3,  5, 59, 0.18),
  ('10000000-0000-4000-8000-000000000001', now() - interval '1000 hours', 15,  1,  0, 10, 0.7,  8, 23, 0.0034),
  ('10000000-0000-4000-8000-000000000002', now() - interval '47 hours',    1,  0,  0,  1, 0.25, 0, 37, 0.102);

insert into public.user_strikes (user_id, severity, points, reason)
select user_id, 'info', least(points, 5), 'fixture'
  from public.reach_fixture f, generate_series(1, 2) g(n),
       lateral (select case when g.n = 1 then least(f.strike_points, 5) else f.strike_points - 5 end as points) p
 where p.points > 0;

create or replace view public.moderation_reputation_inputs as
select user_id, account_created_at, posts, endorsed_posts, endorsements_given, reports_received, far_rate
  from public.reach_fixture;

set local role service_role;

select is(
  (select count(*) from public.reach_fixture f where public.get_active_strike_points(f.user_id) <> f.strike_points),
  0::bigint, 'fixture strike points are in place');

select results_eq(
  $$ select f.user_id, public.get_user_reputation(f.user_id) from public.reach_fixture f order by 1 $$,
  $$ select f.user_id, f.expected_reputation from public.reach_fixture f order by 1 $$,
  'get_user_reputation matches the fixture on every row');

select results_eq(
  $$ select f.user_id, round(rc.coefficient, 4), rc.enabled
       from public.reach_fixture f, public.calculate_reach_coefficient(f.user_id) rc order by 1 $$,
  $$ select f.user_id, f.expected_coefficient, true from public.reach_fixture f order by 1 $$,
  'calculate_reach_coefficient matches the fixture on every row');

select results_eq(
  $$ select age_factor, reputation_factor, strike_factor, engagement_factor, far_report_factor,
            round(account_age_hours), reputation_score, active_strike_points, posts, endorsed_posts,
            endorsements_given, reports_received, far_rate
       from public.calculate_reach_coefficient('10000000-0000-4000-8000-000000000001') $$,
  $$ values (1.0::numeric, 0.4::numeric, 0.1::numeric, 0.85::numeric, 0.1::numeric,
             1000::numeric, 23, 8, 15, 1, 0, 10, 0.7::numeric) $$,
  'every factor and input is returned');

-- Unknown user: config.reach.unknownUserCoefficient with null factors.
select results_eq(
  $$ select coefficient, enabled, age_factor, reputation_factor, reputation_score, active_strike_points
       from public.calculate_reach_coefficient('30000000-0000-4000-8000-0000000000ff') $$,
  $$ values (0.5::numeric, true, null::numeric, null::numeric, null::integer, 0) $$,
  'a user with no view row gets the unknown user coefficient and null factors');
select is(public.get_user_reputation('30000000-0000-4000-8000-0000000000ff'), null, 'get_user_reputation is null without a view row');

-- Disabled: coefficient 1.0, factors 1.0, inputs still populated.
update public.moderation_settings set reach_enabled = false;
select results_eq(
  $$ select coefficient, enabled, age_factor, reputation_factor, strike_factor, engagement_factor, far_report_factor,
            reputation_score, active_strike_points, posts
       from public.calculate_reach_coefficient('10000000-0000-4000-8000-000000000001') $$,
  $$ values (1.0::numeric, false, 1.0::numeric, 1.0::numeric, 1.0::numeric, 1.0::numeric, 1.0::numeric, 23, 8, 15) $$,
  'with reach disabled the coefficient and factors are 1.0 and inputs are populated');
update public.moderation_settings set reach_enabled = true;

-- Boundaries of the step tables.
reset role;
update public.reach_fixture set account_created_at = now() - interval '48 hours' where user_id = '20000000-0000-4000-8000-000000000001';
select is((select age_factor from public.calculate_reach_coefficient('20000000-0000-4000-8000-000000000001')), 0.75::numeric, 'age 48 hours is the second step');
update public.reach_fixture set account_created_at = now() - interval '336 hours' where user_id = '20000000-0000-4000-8000-000000000001';
select is((select age_factor from public.calculate_reach_coefficient('20000000-0000-4000-8000-000000000001')), 1.0::numeric, 'age 336 hours is otherwise');
update public.reach_fixture set far_rate = 0.5 where user_id = '20000000-0000-4000-8000-000000000001';
select is((select far_report_factor from public.calculate_reach_coefficient('20000000-0000-4000-8000-000000000001')), 0.1::numeric, 'far_rate 0.5 is otherwise');
update public.reach_fixture set far_rate = null where user_id = '20000000-0000-4000-8000-000000000001';
select is((select far_report_factor from public.calculate_reach_coefficient('20000000-0000-4000-8000-000000000001')), 1.0::numeric, 'null far_rate is factor 1.0');
update public.reach_fixture set reports_received = 2, endorsed_posts = 4 where user_id = '20000000-0000-4000-8000-000000000001';
select is((select engagement_factor from public.calculate_reach_coefficient('20000000-0000-4000-8000-000000000001')), 0.85::numeric, 'a ratio equal to neutralRatio is the penalty');
update public.reach_fixture set reports_received = 2, endorsed_posts = 5 where user_id = '20000000-0000-4000-8000-000000000001';
select is((select engagement_factor from public.calculate_reach_coefficient('20000000-0000-4000-8000-000000000001')), 1.0::numeric, 'a ratio above neutralRatio is neutral');

select ok((select count(*) from public.reach_fixture) = 8, 'eight fixture rows');

select * from finish();
rollback;
