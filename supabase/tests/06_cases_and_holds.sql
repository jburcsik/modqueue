-- One open case per target; held content always has a case.
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

-- One open case per target is an index, so a race ends in a unique violation.
select throws_ok(
  $$ insert into public.moderation_cases (target_id) values ('30000000-0000-4000-8000-000000000008') $$,
  '23505', null, 'a second open case for a target violates the unique index');
select throws_ok(
  $$ insert into public.moderation_cases (target_id, state) values ('30000000-0000-4000-8000-000000000009', 'claimed') $$,
  '23505', null, 'a claimed case counts as open for the index');
select lives_ok(
  $$ insert into public.moderation_cases (target_id, state, decision, decided_at) values ('30000000-0000-4000-8000-000000000008', 'decided', 'keep', now()) $$,
  'decided cases accumulate freely');

-- Inserting held content opens a case.
insert into public.moderation_content (id, owner_id, moderation_state, body)
values ('30000000-0000-4000-8000-0000000000aa', '20000000-0000-4000-8000-000000000001', 'held', 'held on insert');
select is(
  (select count(*) from public.moderation_cases where target_id = '30000000-0000-4000-8000-0000000000aa' and state = 'open'),
  1::bigint, 'inserting held content opens one case');

-- Updating content to held opens a case; a second update does not open another.
update public.moderation_content set moderation_state = 'held' where id = '30000000-0000-4000-8000-000000000001';
select is(
  (select count(*) from public.moderation_cases where target_id = '30000000-0000-4000-8000-000000000001' and state = 'open'),
  1::bigint, 'updating content to held opens one case');
update public.moderation_content set moderation_state = 'held' where id = '30000000-0000-4000-8000-000000000001';
select is(
  (select count(*) from public.moderation_cases where target_id = '30000000-0000-4000-8000-000000000001'),
  1::bigint, 'a repeated hold does not open a second case');

-- Visible and removed content opens nothing.
insert into public.moderation_content (id, owner_id, moderation_state)
values ('30000000-0000-4000-8000-0000000000bb', '20000000-0000-4000-8000-000000000001', 'visible'),
       ('30000000-0000-4000-8000-0000000000cc', '20000000-0000-4000-8000-000000000001', 'removed');
select is(
  (select count(*) from public.moderation_cases where target_id in ('30000000-0000-4000-8000-0000000000bb', '30000000-0000-4000-8000-0000000000cc')),
  0::bigint, 'visible and removed content opens no case');

-- The queue view: one row per case, preview from body, report counts.
select results_eq(
  $$ select content_id, owner_id, moderation_state, preview, open_report_count, total_report_count
       from public.moderation_queue where case_id = '60000000-0000-4000-8000-000000000003' $$,
  $$ values ('30000000-0000-4000-8000-000000000010'::uuid, '20000000-0000-4000-8000-000000000003'::uuid, 'held',
             'This whole block is full of people who should move away.', 3, 3) $$,
  'the queue joins the case to its content and counts reports');
select is(
  (select preview from public.moderation_queue where case_id = '60000000-0000-4000-8000-000000000004'),
  'Posting the licence plate of the person who cut me off.',
  'preview is the body up to 240 characters');

select * from finish();
rollback;
