-- modqueue fixture seed. Every row is invented.
--
-- Users: one moderator, one admin, six members. All sign in with the
-- password "modqueue-seed". Member six is a new account.
--
--   10000000-0000-4000-8000-000000000001  moderator@example.com  Reviewer A
--   10000000-0000-4000-8000-000000000002  admin@example.com      Reviewer B
--   20000000-0000-4000-8000-000000000001  member1@example.com    clean, one expired strike
--   20000000-0000-4000-8000-000000000002  member2@example.com    nudge (2 points), one pending appeal
--   20000000-0000-4000-8000-000000000003  member3@example.com    warned (4 points)
--   20000000-0000-4000-8000-000000000004  member4@example.com    review gated (6 points)
--   20000000-0000-4000-8000-000000000005  member5@example.com    quieted (8 points)
--   20000000-0000-4000-8000-000000000006  member6@example.com    clean, one revoked strike, account twelve hours old
--
-- Content ids are 30000000-..., strikes 40000000-..., reports 50000000-...,
-- cases 60000000-..., appeals 70000000-..., events 80000000-....

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new
)
select
  '00000000-0000-0000-0000-000000000000',
  u.id,
  'authenticated',
  'authenticated',
  u.email,
  extensions.crypt('modqueue-seed', extensions.gen_salt('bf')),
  now() - u.age,
  '{"provider": "email", "providers": ["email"]}'::jsonb,
  '{}'::jsonb,
  now() - u.age,
  now() - u.age,
  '', '', '', ''
from (values
  ('10000000-0000-4000-8000-000000000001'::uuid, 'moderator@example.com', interval '400 days'),
  ('10000000-0000-4000-8000-000000000002'::uuid, 'admin@example.com',     interval '400 days'),
  ('20000000-0000-4000-8000-000000000001'::uuid, 'member1@example.com',   interval '200 days'),
  ('20000000-0000-4000-8000-000000000002'::uuid, 'member2@example.com',   interval '90 days'),
  ('20000000-0000-4000-8000-000000000003'::uuid, 'member3@example.com',   interval '60 days'),
  ('20000000-0000-4000-8000-000000000004'::uuid, 'member4@example.com',   interval '30 days'),
  ('20000000-0000-4000-8000-000000000005'::uuid, 'member5@example.com',   interval '20 days'),
  ('20000000-0000-4000-8000-000000000006'::uuid, 'member6@example.com',   interval '12 hours')
) as u(id, email, age)
on conflict (id) do nothing;

insert into auth.identities (
  id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
)
select
  u.id, u.id, u.id::text,
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
  'email', now(), u.created_at, u.created_at
from auth.users u
where u.email like '%@example.com'
on conflict (provider_id, provider) do nothing;

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------

insert into public.moderation_roles (user_id, role, display_name) values
  ('10000000-0000-4000-8000-000000000001', 'moderator', 'Reviewer A'),
  ('10000000-0000-4000-8000-000000000002', 'admin',     'Reviewer B')
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------------
-- Settings: equal to defaultConfig.settings
-- ---------------------------------------------------------------------------

insert into public.moderation_settings (
  id, automation_level, warn_threshold, hold_threshold, auto_action_confidence,
  auto_warn_keywords, auto_block_keywords, full_auto_acknowledged_at,
  auto_hide_weight, report_min_account_age_hours,
  report_rate_max, report_rate_window_seconds,
  appeal_rate_max, appeal_rate_window_seconds,
  report_identity_retention_days, reach_enabled
) values (
  'default', 'assist', 0.5, 0.8, 0.75,
  '{}', '{}', null,
  3.5, 48,
  5, 3600,
  3, 86400,
  60, true
)
on conflict (id) do update set
  automation_level               = excluded.automation_level,
  warn_threshold                 = excluded.warn_threshold,
  hold_threshold                 = excluded.hold_threshold,
  auto_action_confidence         = excluded.auto_action_confidence,
  auto_warn_keywords             = excluded.auto_warn_keywords,
  auto_block_keywords            = excluded.auto_block_keywords,
  full_auto_acknowledged_at      = excluded.full_auto_acknowledged_at,
  auto_hide_weight               = excluded.auto_hide_weight,
  report_min_account_age_hours   = excluded.report_min_account_age_hours,
  report_rate_max                = excluded.report_rate_max,
  report_rate_window_seconds     = excluded.report_rate_window_seconds,
  appeal_rate_max                = excluded.appeal_rate_max,
  appeal_rate_window_seconds     = excluded.appeal_rate_window_seconds,
  report_identity_retention_days = excluded.report_identity_retention_days,
  reach_enabled                  = excluded.reach_enabled;

-- ---------------------------------------------------------------------------
-- Cases first, so the held-content trigger finds them already open
-- ---------------------------------------------------------------------------

insert into public.moderation_cases (id, target_id, state, claimed_by, claimed_at, decided_at, decision, created_at) values
  ('60000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000008', 'open',    null, null, null, null, now() - interval '2 days'),
  ('60000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000009', 'claimed', '10000000-0000-4000-8000-000000000001', now() - interval '3 hours', null, null, now() - interval '1 day'),
  ('60000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000010', 'open',    null, null, null, null, now() - interval '6 hours'),
  ('60000000-0000-4000-8000-000000000004', '30000000-0000-4000-8000-000000000011', 'decided', null, null, now() - interval '70 days', 'remove', now() - interval '71 days'),
  ('60000000-0000-4000-8000-000000000005', '30000000-0000-4000-8000-000000000012', 'decided', null, null, now() - interval '5 hours', 'remove', now() - interval '6 hours'),
  ('60000000-0000-4000-8000-000000000006', '30000000-0000-4000-8000-000000000004', 'decided', null, null, now() - interval '3 days', 'keep',   now() - interval '4 days')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Content: seven visible, three held, two removed
-- ---------------------------------------------------------------------------

insert into public.moderation_content (id, owner_id, moderation_state, created_at, body) values
  ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'visible', now() - interval '20 days', 'Found a set of keys on the bench by the fountain. Left them with the cafe.'),
  ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 'visible', now() - interval '9 days',  'Street light at the corner has been out for a week.'),
  ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000002', 'visible', now() - interval '8 days',  'Free shelving unit on the curb, first come first served.'),
  ('30000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000002', 'visible', now() - interval '5 days',  'Anyone know a good plumber who does weekends?'),
  ('30000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000003', 'visible', now() - interval '4 days',  'Lost grey cat with white paws, answers to Pebble.'),
  ('30000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000003', 'visible', now() - interval '3 days',  'Community garden plots open for the season, sign up at the shed.'),
  ('30000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000005', 'visible', now() - interval '2 days',  'Loud construction starting early again, anyone else hearing it?'),
  ('30000000-0000-4000-8000-000000000008', '20000000-0000-4000-8000-000000000004', 'held',    now() - interval '2 days',  'Selling a bike, slightly used, message me for details.'),
  ('30000000-0000-4000-8000-000000000009', '20000000-0000-4000-8000-000000000005', 'held',    now() - interval '1 day',   'Did anyone see who dented the blue car on the side street last night?'),
  ('30000000-0000-4000-8000-000000000010', '20000000-0000-4000-8000-000000000003', 'held',    now() - interval '7 hours', 'This whole block is full of people who should move away.'),
  ('30000000-0000-4000-8000-000000000011', '20000000-0000-4000-8000-000000000005', 'removed', now() - interval '72 days', 'Posting the licence plate of the person who cut me off.'),
  ('30000000-0000-4000-8000-000000000012', '20000000-0000-4000-8000-000000000006', 'removed', now() - interval '7 hours', 'Buy followers cheap, link in my bio.')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------------

insert into public.moderation_events (id, target_type, target_id, case_id, event_type, source, severity, summary, details, actor_id, prior_state, created_at) values
  ('80000000-0000-4000-8000-000000000001', 'content', '30000000-0000-4000-8000-000000000008', '60000000-0000-4000-8000-000000000001', 'tier_hold',       'system',    'info',      'Held for review: owner is review gated',           '{"release_below_points": 6, "active_points": 6}', null, null, now() - interval '2 days'),
  ('80000000-0000-4000-8000-000000000002', 'content', '30000000-0000-4000-8000-000000000009', '60000000-0000-4000-8000-000000000002', 'content_hold',    'moderator', 'warning',   'Held pending a closer look',                       '{}', '10000000-0000-4000-8000-000000000001', 'visible', now() - interval '1 day'),
  ('80000000-0000-4000-8000-000000000003', 'content', '30000000-0000-4000-8000-000000000011', '60000000-0000-4000-8000-000000000004', 'content_remove',  'moderator', 'violation', 'Removed: shares personal information',             '{"decision": "remove", "flag_justified": true}', '10000000-0000-4000-8000-000000000001', 'visible', now() - interval '70 days'),
  ('80000000-0000-4000-8000-000000000004', 'content', '30000000-0000-4000-8000-000000000012', '60000000-0000-4000-8000-000000000005', 'content_remove',  'automated', 'violation', 'Removed: spam',                                    '{"decision": "remove", "flag_justified": true}', null, 'visible', now() - interval '5 hours'),
  ('80000000-0000-4000-8000-000000000005', 'content', '30000000-0000-4000-8000-000000000004', '60000000-0000-4000-8000-000000000006', 'content_approve', 'moderator', 'info',      'Kept: report not justified',                       '{"decision": "keep", "flag_justified": false}', '10000000-0000-4000-8000-000000000001', 'visible', now() - interval '3 days'),
  ('80000000-0000-4000-8000-000000000006', 'user',    '20000000-0000-4000-8000-000000000005', null, 'strike_added',    'moderator', 'severe',    'Strike added: shared personal information',        '{"points": 5}', '10000000-0000-4000-8000-000000000001', null, now() - interval '70 days'),
  ('80000000-0000-4000-8000-000000000007', 'user',    '20000000-0000-4000-8000-000000000002', null, 'strike_added',    'moderator', 'warning',   'Strike added: repeated off topic posts',           '{"points": 2}', '10000000-0000-4000-8000-000000000001', null, now() - interval '10 days'),
  ('80000000-0000-4000-8000-000000000008', 'user',    '20000000-0000-4000-8000-000000000006', null, 'strike_revoked',  'admin',     'info',      'Strike revoked after review',                      '{}', '10000000-0000-4000-8000-000000000002', null, now() - interval '1 hour')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Strikes: one member per ladder tier
-- ---------------------------------------------------------------------------

insert into public.user_strikes (id, user_id, severity, points, reason, moderation_event_id, expires_at, revoked_at, revoked_by, created_at) values
  ('40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'info',      1, 'Minor tone issue',                 null, now() - interval '10 days', null, null, now() - interval '70 days'),
  ('40000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'warning',   2, 'Repeated off topic posts',         '80000000-0000-4000-8000-000000000007', now() + interval '50 days', null, null, now() - interval '10 days'),
  ('40000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000003', 'warning',   2, 'Unkind reply',                     null, now() + interval '40 days', null, null, now() - interval '20 days'),
  ('40000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000003', 'warning',   2, 'Second unkind reply',              null, now() + interval '55 days', null, null, now() - interval '5 days'),
  ('40000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000004', 'violation', 3, 'Harassing comment',                null, now() + interval '45 days', null, null, now() - interval '15 days'),
  ('40000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000004', 'violation', 3, 'Second harassing comment',         null, now() + interval '57 days', null, null, now() - interval '3 days'),
  ('40000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000005', 'severe',    5, 'Shared personal information',      '80000000-0000-4000-8000-000000000006', null, null, null, now() - interval '70 days'),
  ('40000000-0000-4000-8000-000000000008', '20000000-0000-4000-8000-000000000005', 'violation', 3, 'Targeted harassment',              null, now() + interval '30 days', null, null, now() - interval '30 days'),
  ('40000000-0000-4000-8000-000000000009', '20000000-0000-4000-8000-000000000006', 'violation', 3, 'Spam, revoked after review',       null, now() + interval '59 days', now() - interval '1 hour', '10000000-0000-4000-8000-000000000002', now() - interval '5 hours')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Reports at mixed trust weights
-- ---------------------------------------------------------------------------

insert into public.moderation_reports (id, case_id, target_id, reporter_id, reason, evidence_paths, trust_weight, state, created_at, resolved_at) values
  ('50000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000010', '20000000-0000-4000-8000-000000000001', 'Targets a group of residents',       '{}', 1.5, 'open',     now() - interval '6 hours', null),
  ('50000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000010', '20000000-0000-4000-8000-000000000002', 'Hostile',                             '{}', 1.1, 'open',     now() - interval '5 hours', null),
  ('50000000-0000-4000-8000-000000000003', '60000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000010', '20000000-0000-4000-8000-000000000004', 'Not appropriate here',                '{evidence/screens/one.png}', 1.0, 'open', now() - interval '4 hours', null),
  ('50000000-0000-4000-8000-000000000004', '60000000-0000-4000-8000-000000000004', '30000000-0000-4000-8000-000000000011', '20000000-0000-4000-8000-000000000001', 'Posts a licence plate',               '{}', 1.2, 'upheld',   now() - interval '71 days', now() - interval '70 days'),
  ('50000000-0000-4000-8000-000000000005', '60000000-0000-4000-8000-000000000004', '30000000-0000-4000-8000-000000000011', '20000000-0000-4000-8000-000000000003', 'Personal information',                '{}', 0.9, 'upheld',   now() - interval '71 days', now() - interval '5 days'),
  ('50000000-0000-4000-8000-000000000006', '60000000-0000-4000-8000-000000000006', '30000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000005', 'Advertising',                         '{}', 0.6, 'rejected', now() - interval '4 days',  now() - interval '3 days'),
  ('50000000-0000-4000-8000-000000000007', '60000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000009', '20000000-0000-4000-8000-000000000002', 'Could identify one resident', '{}', 1.0, 'open',     now() - interval '20 hours', null)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- One pending appeal
-- ---------------------------------------------------------------------------

insert into public.moderation_appeals (id, user_id, strike_id, moderation_event_id, statement, state, created_at) values
  ('70000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002', '80000000-0000-4000-8000-000000000007', 'The posts were replies to questions in the thread, not off topic on their own.', 'pending', now() - interval '2 days')
on conflict (id) do nothing;
