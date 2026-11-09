-- modqueue baseline.
--
-- Order: schemas, tables, views, functions, triggers, grants, scheduled jobs.
-- Every CHECK list carries the values of the matching array in src/types.ts
-- in the same order. Every moderation_settings default equals the matching
-- field of defaultConfig.settings in src/config.ts. The reach and reputation
-- literals mirror defaultConfig.reach and defaultConfig.reputation.
-- Re-running this file on a database that already carries it is a no-op.

-- ===========================================================================
-- Schemas
-- ===========================================================================

create schema if not exists internal;

revoke all on schema internal from public, anon, authenticated;
grant usage on schema internal to service_role;
alter default privileges in schema internal grant all on tables to service_role;
alter default privileges in schema internal grant all on sequences to service_role;

-- ===========================================================================
-- Tables
-- ===========================================================================

create table if not exists public.moderation_roles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  role         text not null check (role in ('member', 'moderator', 'admin')),
  display_name text,
  created_at   timestamptz not null default now()
);

-- Example content table. A host replaces it with an updatable view exposing
-- these five columns and recreates trg_open_case_for_held on its base table.
create table if not exists public.moderation_content (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users(id) on delete cascade,
  moderation_state text not null default 'visible' check (moderation_state in ('visible', 'held', 'removed')),
  created_at       timestamptz not null default now(),
  body             text
);

create index if not exists moderation_content_owner_idx
  on public.moderation_content (owner_id);
create index if not exists moderation_content_not_visible_idx
  on public.moderation_content (moderation_state)
  where moderation_state <> 'visible';

create table if not exists public.moderation_settings (
  id                             text primary key default 'default' check (id = 'default'),
  automation_level               text not null default 'assist' check (automation_level in ('off', 'assist', 'semi_auto', 'full_auto')),
  warn_threshold                 numeric not null default 0.5 check (warn_threshold between 0 and 1),
  hold_threshold                 numeric not null default 0.8 check (hold_threshold between 0 and 1),
  auto_action_confidence         numeric not null default 0.75 check (auto_action_confidence between 0 and 1),
  auto_warn_keywords             text[] not null default '{}',
  auto_block_keywords            text[] not null default '{}',
  full_auto_acknowledged_at      timestamptz,
  auto_hide_weight               numeric not null default 3.5 check (auto_hide_weight > 0),
  report_min_account_age_hours   integer not null default 48 check (report_min_account_age_hours >= 0),
  report_rate_max                integer not null default 5 check (report_rate_max > 0),
  report_rate_window_seconds     integer not null default 3600 check (report_rate_window_seconds > 0),
  appeal_rate_max                integer not null default 3 check (appeal_rate_max > 0),
  appeal_rate_window_seconds     integer not null default 86400 check (appeal_rate_window_seconds > 0),
  report_identity_retention_days integer not null default 60 check (report_identity_retention_days >= 0),
  reach_enabled                  boolean not null default true,
  updated_at                     timestamptz not null default now(),
  updated_by                     uuid references auth.users(id) on delete set null,
  constraint moderation_settings_full_auto_acknowledged
    check (automation_level <> 'full_auto' or full_auto_acknowledged_at is not null)
);

insert into public.moderation_settings (id) values ('default')
on conflict (id) do nothing;

-- Cases come before events because events reference them.
create table if not exists public.moderation_cases (
  id         uuid primary key default gen_random_uuid(),
  target_id  uuid not null,
  state      text not null default 'open' check (state in ('open', 'claimed', 'decided', 'reversed')),
  claimed_by uuid references auth.users(id) on delete set null,
  claimed_at timestamptz,
  decided_at timestamptz,
  decision   text check (decision in ('keep', 'remove', 'restore')),
  created_at timestamptz not null default now()
);

create unique index if not exists moderation_cases_one_open_idx
  on public.moderation_cases (target_id)
  where state in ('open', 'claimed');
create index if not exists moderation_cases_queue_idx
  on public.moderation_cases (state, created_at desc);
create index if not exists moderation_cases_claimed_idx
  on public.moderation_cases (claimed_by)
  where claimed_by is not null;

create table if not exists public.moderation_events (
  id          uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('content', 'user')),
  target_id   uuid not null,
  case_id     uuid references public.moderation_cases(id) on delete set null,
  event_type  text not null check (event_type in ('content_hold', 'content_remove', 'content_restore', 'content_approve', 'content_warn', 'mod_note', 'strike_added', 'strike_revoked', 'tier_hold', 'ai_flag', 'auto_allow', 'escalated', 'user_lookup', 'appeal_filed', 'appeal_resolved', 'tripwire')),
  source      text not null check (source in ('member', 'moderator', 'admin', 'automated', 'provider', 'system')),
  severity    text not null check (severity in ('info', 'warning', 'violation', 'severe')),
  summary     text,
  details     jsonb not null default '{}',
  actor_id    uuid references auth.users(id) on delete set null,
  prior_state text check (prior_state in ('visible', 'held', 'removed')),
  created_at  timestamptz not null default now()
);

create index if not exists moderation_events_target_idx
  on public.moderation_events (target_type, target_id, created_at desc);
create index if not exists moderation_events_type_idx
  on public.moderation_events (event_type, created_at desc);
create index if not exists moderation_events_actor_idx
  on public.moderation_events (actor_id, created_at desc);
create index if not exists moderation_events_case_idx
  on public.moderation_events (case_id);

create table if not exists public.user_strikes (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  severity            text not null check (severity in ('info', 'warning', 'violation', 'severe')),
  points              integer not null check (points between 1 and 5),
  reason              text not null,
  moderation_event_id uuid references public.moderation_events(id) on delete set null,
  expires_at          timestamptz,
  revoked_at          timestamptz,
  revoked_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now()
);

create index if not exists user_strikes_active_idx
  on public.user_strikes (user_id, created_at desc)
  where revoked_at is null;

create table if not exists public.moderation_reports (
  id             uuid primary key default gen_random_uuid(),
  case_id        uuid references public.moderation_cases(id) on delete set null,
  target_id      uuid not null,
  reporter_id    uuid references auth.users(id) on delete set null,
  reason         text check (char_length(reason) <= 500),
  evidence_paths text[] not null default '{}' check (cardinality(evidence_paths) <= 2),
  trust_weight   numeric not null check (trust_weight between 0 and 1.5),
  state          text not null default 'open' check (state in ('open', 'upheld', 'rejected', 'duplicate', 'withdrawn')),
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz
);

create index if not exists moderation_reports_target_idx
  on public.moderation_reports (target_id);
create index if not exists moderation_reports_case_idx
  on public.moderation_reports (case_id);
create unique index if not exists moderation_reports_one_open_idx
  on public.moderation_reports (reporter_id, target_id)
  where state = 'open' and reporter_id is not null;
create index if not exists moderation_reports_purge_idx
  on public.moderation_reports (resolved_at)
  where reporter_id is not null and resolved_at is not null;

create table if not exists public.moderation_appeals (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  strike_id           uuid not null references public.user_strikes(id) on delete cascade,
  moderation_event_id uuid references public.moderation_events(id) on delete set null,
  statement           text not null check (char_length(statement) between 10 and 1000),
  state               text not null default 'pending' check (state in ('pending', 'upheld', 'overturned')),
  resolved_by         uuid references auth.users(id) on delete set null,
  resolved_at         timestamptz,
  reviewer_note       text,
  created_at          timestamptz not null default now()
);

create unique index if not exists moderation_appeals_one_pending_idx
  on public.moderation_appeals (strike_id)
  where state = 'pending';
create index if not exists moderation_appeals_user_idx
  on public.moderation_appeals (user_id, created_at desc);

create table if not exists internal.rate_limit_entries (
  key        text not null,
  created_at timestamptz not null default now()
);

create index if not exists rate_limit_entries_key_time_idx
  on internal.rate_limit_entries (key, created_at);

-- ===========================================================================
-- Views
-- ===========================================================================

-- Example reputation inputs. A host replaces this view with one over its own
-- tables exposing the same seven columns, one row per user. It reads
-- auth.users with the owner's rights; only service_role may select from it,
-- and file_report_for reads account_created_at from it.
create or replace view public.moderation_reputation_inputs as
select
  u.id                                                        as user_id,
  u.created_at                                                as account_created_at,
  (select count(*)::integer
     from public.moderation_content c
    where c.owner_id = u.id)                                  as posts,
  0::integer                                                  as endorsed_posts,
  0::integer                                                  as endorsements_given,
  (select count(*)::integer
     from public.moderation_reports r
     join public.moderation_content c on c.id = r.target_id
    where c.owner_id = u.id
      and r.state = 'upheld')                                  as reports_received,
  null::numeric                                               as far_rate
from auth.users u;

create or replace view public.moderation_queue
with (security_invoker = true)
as
select
  c.id                  as case_id,
  c.state               as case_state,
  c.claimed_by,
  c.claimed_at,
  c.created_at          as case_created_at,
  mc.id                 as content_id,
  mc.owner_id,
  mc.moderation_state,
  mc.created_at         as content_created_at,
  left(mc.body, 240)    as preview,
  (select count(*)::integer from public.moderation_reports r
    where r.case_id = c.id and r.state = 'open')  as open_report_count,
  (select count(*)::integer from public.moderation_reports r
    where r.case_id = c.id)                       as total_report_count
from public.moderation_cases c
join public.moderation_content mc on mc.id = c.target_id;

-- ===========================================================================
-- Functions: service side
-- ===========================================================================

create or replace function public.check_rate_limit(
  p_key            text,
  p_window_seconds integer,
  p_max            integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window_start timestamptz := now() - make_interval(secs => p_window_seconds);
  v_count        integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_key));

  select count(*) into v_count
    from internal.rate_limit_entries
   where key = p_key and created_at > v_window_start;

  if v_count >= p_max then
    return false;
  end if;

  insert into internal.rate_limit_entries (key) values (p_key);

  delete from internal.rate_limit_entries
   where key = p_key and created_at <= v_window_start;

  return true;
end;
$$;

create or replace function public.get_active_strike_points(p_user_id uuid)
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(sum(points), 0)::integer
    from public.user_strikes
   where user_id = p_user_id
     and revoked_at is null
     and (expires_at is null or expires_at > now());
$$;

-- Mirrors calculateReputationScore with defaultConfig.reputation.
create or replace function public.get_user_reputation(p_user_id uuid)
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select round(greatest(0, least(100,
           40
           + least(i.endorsed_posts * 3, 24)
           + least(i.endorsements_given * 0.5, 10)
           + least(i.posts * 1, 12)
           - least(i.reports_received * 4, 32)
         )))::integer
    from public.moderation_reputation_inputs i
   where i.user_id = p_user_id;
$$;

-- Mirrors computeReach with defaultConfig.reach.
create or replace function public.calculate_reach_coefficient(p_user_id uuid)
returns table (
  coefficient          numeric,
  enabled              boolean,
  age_factor           numeric,
  reputation_factor    numeric,
  strike_factor        numeric,
  engagement_factor    numeric,
  far_report_factor    numeric,
  account_age_hours    numeric,
  reputation_score     integer,
  active_strike_points integer,
  posts                integer,
  endorsed_posts       integer,
  endorsements_given   integer,
  reports_received     integer,
  far_rate             numeric
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_inputs public.moderation_reputation_inputs%rowtype;
begin
  select s.reach_enabled into enabled
    from public.moderation_settings s
   where s.id = 'default';
  enabled := coalesce(enabled, true);

  active_strike_points := public.get_active_strike_points(p_user_id);

  select * into v_inputs
    from public.moderation_reputation_inputs i
   where i.user_id = p_user_id;

  if not found then
    coefficient := 0.5;
    return next;
    return;
  end if;

  account_age_hours  := extract(epoch from (now() - v_inputs.account_created_at)) / 3600.0;
  reputation_score   := public.get_user_reputation(p_user_id);
  posts              := v_inputs.posts;
  endorsed_posts     := v_inputs.endorsed_posts;
  endorsements_given := v_inputs.endorsements_given;
  reports_received   := v_inputs.reports_received;
  far_rate           := v_inputs.far_rate;

  if not enabled then
    coefficient       := 1.0;
    age_factor        := 1.0;
    reputation_factor := 1.0;
    strike_factor     := 1.0;
    engagement_factor := 1.0;
    far_report_factor := 1.0;
    return next;
    return;
  end if;

  age_factor := case
    when account_age_hours < 48  then 0.5
    when account_age_hours < 168 then 0.75
    when account_age_hours < 336 then 0.9
    else 1.0
  end;

  reputation_factor := case
    when reputation_score < 25 then 0.4
    when reputation_score < 40 then 0.6
    when reputation_score < 55 then 0.8
    when reputation_score < 70 then 1.0
    when reputation_score < 85 then 1.1
    else 1.15
  end;

  strike_factor := case
    when active_strike_points < 1 then 1.0
    when active_strike_points < 4 then 0.75
    when active_strike_points < 6 then 0.45
    when active_strike_points < 8 then 0.15
    else 0.1
  end;

  engagement_factor := case
    when reports_received = 0 and endorsed_posts >= 8 then 1.1
    when reports_received = 0 then 1.0
    when endorsed_posts::numeric / reports_received > 2 then 1.0
    else 0.85
  end;

  far_report_factor := case
    when far_rate is null  then 1.0
    when far_rate < 0.25   then 1.0
    when far_rate < 0.5    then 0.4
    else 0.1
  end;

  coefficient := greatest(0, least(1.5,
    age_factor * reputation_factor * strike_factor * engagement_factor * far_report_factor
  ));

  return next;
end;
$$;

create or replace function public.decide_moderation_case(
  p_case_id        uuid,
  p_decision       text,
  p_flag_justified boolean,
  p_actor_id       uuid,
  p_source         text,
  p_reason         text
)
returns table (
  case_id          uuid,
  decision         text,
  moderation_state text,
  prior_state      text,
  reports_resolved integer,
  event_id         uuid
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_case public.moderation_cases%rowtype;
begin
  select * into v_case from public.moderation_cases c where c.id = p_case_id;
  if not found then
    raise exception using message = 'not_found', errcode = 'MQ003';
  end if;

  if v_case.state = 'reversed' or (v_case.state = 'decided' and p_decision <> 'restore') then
    raise exception using message = 'case_not_open', errcode = 'MQ013';
  end if;

  if p_decision not in ('keep', 'remove', 'restore')
     or p_source not in ('member', 'moderator', 'admin', 'automated', 'provider', 'system') then
    raise exception using message = 'invalid_input', errcode = 'MQ004';
  end if;

  select mc.moderation_state into prior_state
    from public.moderation_content mc
   where mc.id = v_case.target_id;
  if not found then
    raise exception using message = 'not_found', errcode = 'MQ003';
  end if;

  -- Restore reverses a remove ruling only: the case carries decision remove,
  -- no later case exists for the target, and the content is still removed.
  if p_decision = 'restore'
     and (v_case.decision is distinct from 'remove'
          or decide_moderation_case.prior_state <> 'removed'
          or exists (
            select 1 from public.moderation_cases c2
             where c2.target_id = v_case.target_id and c2.created_at > v_case.created_at)) then
    raise exception using message = 'case_not_open', errcode = 'MQ013';
  end if;

  moderation_state := case when p_decision = 'remove' then 'removed' else 'visible' end;

  update public.moderation_content mc
     set moderation_state = decide_moderation_case.moderation_state
   where mc.id = v_case.target_id;

  update public.moderation_reports r
     set state = case when p_flag_justified is true then 'upheld' else 'rejected' end,
         resolved_at = now()
   where r.case_id = p_case_id and r.state = 'open';
  get diagnostics reports_resolved = row_count;

  update public.moderation_cases c
     set state      = case when p_decision = 'restore' then 'reversed' else 'decided' end,
         decision   = p_decision,
         decided_at = now()
   where c.id = p_case_id;

  insert into public.moderation_events (
    target_type, target_id, case_id, event_type, source, severity,
    summary, details, actor_id, prior_state
  )
  values (
    'content',
    v_case.target_id,
    p_case_id,
    case p_decision
      when 'keep'    then 'content_approve'
      when 'remove'  then 'content_remove'
      when 'restore' then 'content_restore'
    end,
    p_source,
    case when p_decision = 'remove' then 'violation' else 'info' end,
    p_reason,
    jsonb_build_object('decision', p_decision, 'flag_justified', p_flag_justified),
    p_actor_id,
    decide_moderation_case.prior_state
  )
  returning id into event_id;

  case_id  := p_case_id;
  decision := p_decision;
  return next;
end;
$$;

create or replace function public.file_report_for(
  p_reporter_id    uuid,
  p_target_id      uuid,
  p_reason         text,
  p_evidence_paths text[]
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_settings     public.moderation_settings%rowtype;
  v_account_at   timestamptz;
  v_owner_id     uuid;
  v_state        text;
  v_paths        text[] := coalesce(p_evidence_paths, '{}');
  v_path         text;
  v_trust_weight numeric;
  v_case_id      uuid;
  v_report_id    uuid;
  v_open_weight  numeric;
begin
  select * into v_settings from public.moderation_settings s where s.id = 'default';

  select i.account_created_at into v_account_at
    from public.moderation_reputation_inputs i
   where i.user_id = p_reporter_id;
  if not found then
    raise exception using message = 'not_found', errcode = 'MQ003';
  end if;
  if v_account_at > now() - make_interval(hours => v_settings.report_min_account_age_hours) then
    raise exception using message = 'account_too_new', errcode = 'MQ006';
  end if;

  if not public.check_rate_limit(
    'report:' || p_reporter_id::text,
    v_settings.report_rate_window_seconds,
    v_settings.report_rate_max
  ) then
    raise exception using message = 'rate_limited', errcode = 'MQ005';
  end if;

  -- Members only see visible rows, so a hidden target reads as missing.
  select mc.owner_id, mc.moderation_state into v_owner_id, v_state
    from public.moderation_content mc
   where mc.id = p_target_id;
  if not found or v_state <> 'visible' then
    raise exception using message = 'not_found', errcode = 'MQ003';
  end if;

  if v_owner_id = p_reporter_id then
    raise exception using message = 'self_report', errcode = 'MQ007';
  end if;

  if char_length(p_reason) > 500 or cardinality(v_paths) > 2 then
    raise exception using message = 'invalid_input', errcode = 'MQ004';
  end if;
  foreach v_path in array v_paths loop
    if v_path is null
       or char_length(v_path) > 255
       or v_path !~ '^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9._-]+)*$'
       or v_path ~ '(^|/)\.\.?(/|$)' then
      raise exception using message = 'invalid_input', errcode = 'MQ004';
    end if;
  end loop;

  if exists (
    select 1 from public.moderation_reports r
     where r.reporter_id = p_reporter_id
       and r.target_id = p_target_id
       and r.state = 'open'
  ) then
    raise exception using message = 'duplicate_report', errcode = 'MQ008';
  end if;

  select rc.coefficient into v_trust_weight
    from public.calculate_reach_coefficient(p_reporter_id) rc;

  select c.id into v_case_id
    from public.moderation_cases c
   where c.target_id = p_target_id and c.state in ('open', 'claimed');
  if v_case_id is null then
    insert into public.moderation_cases (target_id, state)
    values (p_target_id, 'open')
    returning id into v_case_id;
  end if;

  insert into public.moderation_reports (case_id, target_id, reporter_id, reason, evidence_paths, trust_weight)
  values (v_case_id, p_target_id, p_reporter_id, p_reason, v_paths, v_trust_weight)
  returning id into v_report_id;

  if v_state = 'visible' then
    select coalesce(sum(r.trust_weight), 0) into v_open_weight
      from public.moderation_reports r
     where r.target_id = p_target_id and r.state = 'open';
    if v_open_weight >= v_settings.auto_hide_weight then
      update public.moderation_content mc
         set moderation_state = 'held'
       where mc.id = p_target_id and mc.moderation_state = 'visible';
      if found then
        insert into public.moderation_events (
          target_type, target_id, case_id, event_type, source, severity, summary, details, prior_state
        )
        values (
          'content', p_target_id, v_case_id, 'content_hold', 'system', 'warning',
          'Held: open report weight reached the auto hide threshold',
          jsonb_build_object('reason', 'auto_hide', 'weight_sum', v_open_weight, 'threshold', v_settings.auto_hide_weight),
          'visible'
        );
      end if;
    end if;
  end if;

  return v_report_id;
end;
$$;

create or replace function public.file_appeal_for(
  p_user_id   uuid,
  p_strike_id uuid,
  p_statement text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_settings  public.moderation_settings%rowtype;
  v_strike    public.user_strikes%rowtype;
  v_appeal_id uuid;
begin
  select * into v_settings from public.moderation_settings s where s.id = 'default';

  select * into v_strike from public.user_strikes st where st.id = p_strike_id;
  if not found then
    raise exception using message = 'not_found', errcode = 'MQ003';
  end if;

  if v_strike.user_id <> p_user_id then
    raise exception using message = 'not_strike_owner', errcode = 'MQ010';
  end if;

  if v_strike.revoked_at is not null
     or (v_strike.expires_at is not null and v_strike.expires_at <= now()) then
    raise exception using message = 'strike_inactive', errcode = 'MQ011';
  end if;

  if not public.check_rate_limit(
    'appeal:' || p_user_id::text,
    v_settings.appeal_rate_window_seconds,
    v_settings.appeal_rate_max
  ) then
    raise exception using message = 'rate_limited', errcode = 'MQ005';
  end if;

  if p_statement is null or char_length(p_statement) not between 10 and 1000 then
    raise exception using message = 'invalid_input', errcode = 'MQ004';
  end if;

  if exists (
    select 1 from public.moderation_appeals a
     where a.strike_id = p_strike_id and a.state = 'pending'
  ) then
    raise exception using message = 'duplicate_appeal', errcode = 'MQ009';
  end if;

  insert into public.moderation_appeals (user_id, strike_id, moderation_event_id, statement)
  values (p_user_id, p_strike_id, v_strike.moderation_event_id, p_statement)
  returning id into v_appeal_id;

  insert into public.moderation_events (
    target_type, target_id, event_type, source, severity, summary, details, actor_id
  )
  values (
    'user', p_user_id, 'appeal_filed', 'member', 'info', 'Appeal filed',
    jsonb_build_object('appeal_id', v_appeal_id, 'strike_id', p_strike_id),
    p_user_id
  );

  return v_appeal_id;
end;
$$;

-- Releases content held only by the strike ladder once the owner's active
-- points fall below the release_below_points stored on the tier_hold event.
create or replace function public.sweep_expired_strikes()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  with candidate as (
    select c.id as case_id,
           mc.id as content_id,
           mc.owner_id,
           (select min(case when e.details->>'release_below_points' ~ '^[0-9]+$'
                            then (e.details->>'release_below_points')::integer end)
              from public.moderation_events e
             where e.case_id = c.id and e.event_type = 'tier_hold') as release_below
      from public.moderation_cases c
      join public.moderation_content mc on mc.id = c.target_id
     where c.state = 'open'
       and mc.moderation_state = 'held'
       and not exists (
         select 1 from public.moderation_reports r
          where r.case_id = c.id and r.state = 'open')
       and not exists (
         select 1 from public.moderation_events e
          where e.case_id = c.id and e.event_type <> 'tier_hold')
  ),
  eligible as (
    select * from candidate
     where release_below is not null
       and public.get_active_strike_points(owner_id) < release_below
  ),
  released as (
    update public.moderation_content mc
       set moderation_state = 'visible'
      from eligible e
     where mc.id = e.content_id
    returning e.case_id, mc.id as content_id
  ),
  closed as (
    update public.moderation_cases c
       set state = 'decided', decision = 'keep', decided_at = now()
      from released r
     where c.id = r.case_id
    returning c.id
  ),
  logged as (
    insert into public.moderation_events (
      target_type, target_id, case_id, event_type, source, severity, summary, details, prior_state
    )
    select 'content', r.content_id, r.case_id, 'content_approve', 'system', 'info',
           'Released by the strike sweep: active strike points fell below the hold threshold',
           jsonb_build_object('decision', 'keep', 'released_by_sweep', true),
           'held'
      from released r
    returning id
  )
  select count(*) into v_count from released;

  return v_count;
end;
$$;

create or replace function public.purge_report_identities()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_days  integer;
  v_count integer;
begin
  select s.report_identity_retention_days into v_days
    from public.moderation_settings s where s.id = 'default';

  update public.moderation_reports r
     set reporter_id = null
   where r.reporter_id is not null
     and r.resolved_at is not null
     and r.resolved_at < now() - make_interval(days => v_days);
  get diagnostics v_count = row_count;

  return v_count;
end;
$$;

create or replace function public.purge_orphaned_moderation()
returns table (reports_purged integer, cases_purged integer)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  delete from public.moderation_reports r
   where not exists (select 1 from public.moderation_content mc where mc.id = r.target_id);
  get diagnostics reports_purged = row_count;

  delete from public.moderation_cases c
   where not exists (select 1 from public.moderation_content mc where mc.id = c.target_id);
  get diagnostics cases_purged = row_count;

  return next;
end;
$$;

-- ===========================================================================
-- Functions: client callable
-- ===========================================================================

create or replace function public.get_my_role()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_role text;
begin
  if v_uid is null then
    raise exception using message = 'unauthenticated', errcode = 'MQ001';
  end if;
  select r.role into v_role from public.moderation_roles r where r.user_id = v_uid;
  return coalesce(v_role, 'member');
end;
$$;

create or replace function public.get_my_strike_count()
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null then
    raise exception using message = 'unauthenticated', errcode = 'MQ001';
  end if;
  select count(*) into v_count
    from public.user_strikes s
   where s.user_id = v_uid
     and s.revoked_at is null
     and (s.expires_at is null or s.expires_at > now());
  return v_count;
end;
$$;

create or replace function public.file_report(
  p_target_id      uuid,
  p_reason         text,
  p_evidence_paths text[]
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception using message = 'unauthenticated', errcode = 'MQ001';
  end if;
  return public.file_report_for(v_uid, p_target_id, p_reason, p_evidence_paths);
end;
$$;

create or replace function public.file_appeal(
  p_strike_id uuid,
  p_statement text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception using message = 'unauthenticated', errcode = 'MQ001';
  end if;
  return public.file_appeal_for(v_uid, p_strike_id, p_statement);
end;
$$;

-- ===========================================================================
-- Functions: probes
-- ===========================================================================

create or replace function public.security_definer_functions_without_search_path()
returns table (schema_name text, function_name text, arguments text)
language sql
stable
security invoker
set search_path = ''
as $$
  select n.nspname::text,
         p.proname::text,
         pg_get_function_identity_arguments(p.oid)
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where p.prosecdef
     and n.nspname in ('public', 'internal')
     and (
       p.proconfig is null
       or not exists (
         select 1 from unnest(p.proconfig) c where c like 'search\_path=%'
       )
     )
   order by n.nspname, p.proname;
$$;

create or replace function public.client_callable_definer_functions()
returns table (function_name text, arguments text, anon boolean, authenticated boolean)
language sql
stable
security invoker
set search_path = ''
as $$
  select p.proname::text,
         pg_get_function_identity_arguments(p.oid),
         has_function_privilege('anon', p.oid, 'execute'),
         has_function_privilege('authenticated', p.oid, 'execute')
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where p.prosecdef
     and n.nspname = 'public'
     and not exists (
       select 1 from pg_catalog.pg_depend d
        where d.objid = p.oid and d.deptype = 'e'
     )
     and (
       has_function_privilege('anon', p.oid, 'execute')
       or has_function_privilege('authenticated', p.oid, 'execute')
     )
   order by p.proname, 2;
$$;

-- ===========================================================================
-- Triggers
-- ===========================================================================

create or replace function public.tg_open_case_for_held()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.moderation_state = 'held' then
    insert into public.moderation_cases (target_id, state)
    select new.id, 'open'
     where not exists (
       select 1 from public.moderation_cases c
        where c.target_id = new.id and c.state in ('open', 'claimed')
     );
  end if;
  return null;
end;
$$;

drop trigger if exists trg_open_case_for_held on public.moderation_content;
create trigger trg_open_case_for_held
  after insert or update of moderation_state on public.moderation_content
  for each row execute function public.tg_open_case_for_held();

-- ===========================================================================
-- Grants and row level security
-- ===========================================================================

alter table public.moderation_roles        enable row level security;
alter table public.moderation_content      enable row level security;
alter table public.moderation_settings     enable row level security;
alter table public.moderation_cases        enable row level security;
alter table public.moderation_events       enable row level security;
alter table public.user_strikes            enable row level security;
alter table public.moderation_reports      enable row level security;
alter table public.moderation_appeals      enable row level security;
alter table internal.rate_limit_entries    enable row level security;

revoke all on public.moderation_roles        from public, anon, authenticated;
revoke all on public.moderation_content      from public, anon, authenticated;
revoke all on public.moderation_settings     from public, anon, authenticated;
revoke all on public.moderation_cases        from public, anon, authenticated;
revoke all on public.moderation_events       from public, anon, authenticated;
revoke all on public.user_strikes            from public, anon, authenticated;
revoke all on public.moderation_reports      from public, anon, authenticated;
revoke all on public.moderation_appeals      from public, anon, authenticated;
revoke all on public.moderation_reputation_inputs from public, anon, authenticated;
revoke all on public.moderation_queue        from public, anon, authenticated;
revoke all on internal.rate_limit_entries    from public, anon, authenticated;

grant all on public.moderation_roles        to service_role;
grant all on public.moderation_content      to service_role;
grant all on public.moderation_settings     to service_role;
grant all on public.moderation_cases        to service_role;
grant all on public.moderation_events       to service_role;
grant all on public.user_strikes            to service_role;
grant all on public.moderation_reports      to service_role;
grant all on public.moderation_appeals      to service_role;
grant select on public.moderation_reputation_inputs to service_role;
grant select on public.moderation_queue     to service_role;
grant all on internal.rate_limit_entries    to service_role;

grant select on public.moderation_content to authenticated;
grant select (id, user_id, strike_id, moderation_event_id, statement, state, created_at, resolved_at)
   on public.moderation_appeals to authenticated;

drop policy if exists moderation_content_select_visible_or_own on public.moderation_content;
create policy moderation_content_select_visible_or_own
  on public.moderation_content
  for select
  to authenticated
  using (moderation_state = 'visible' or owner_id = (select auth.uid()));

drop policy if exists moderation_appeals_select_own on public.moderation_appeals;
create policy moderation_appeals_select_own
  on public.moderation_appeals
  for select
  to authenticated
  using (user_id = (select auth.uid()));

revoke execute on function public.check_rate_limit(text, integer, integer)                          from public, anon, authenticated;
revoke execute on function public.get_active_strike_points(uuid)                                    from public, anon, authenticated;
revoke execute on function public.get_user_reputation(uuid)                                         from public, anon, authenticated;
revoke execute on function public.calculate_reach_coefficient(uuid)                                 from public, anon, authenticated;
revoke execute on function public.decide_moderation_case(uuid, text, boolean, uuid, text, text)     from public, anon, authenticated;
revoke execute on function public.file_report_for(uuid, uuid, text, text[])                         from public, anon, authenticated;
revoke execute on function public.file_appeal_for(uuid, uuid, text)                                 from public, anon, authenticated;
revoke execute on function public.sweep_expired_strikes()                                           from public, anon, authenticated;
revoke execute on function public.purge_report_identities()                                         from public, anon, authenticated;
revoke execute on function public.purge_orphaned_moderation()                                       from public, anon, authenticated;
revoke execute on function public.security_definer_functions_without_search_path()                 from public, anon, authenticated;
revoke execute on function public.client_callable_definer_functions()                               from public, anon, authenticated;
revoke execute on function public.tg_open_case_for_held()                                           from public, anon, authenticated;
revoke execute on function public.get_my_role()                                                     from public, anon, authenticated;
revoke execute on function public.get_my_strike_count()                                             from public, anon, authenticated;
revoke execute on function public.file_report(uuid, text, text[])                                   from public, anon, authenticated;
revoke execute on function public.file_appeal(uuid, text)                                           from public, anon, authenticated;

grant execute on function public.check_rate_limit(text, integer, integer)                           to service_role;
grant execute on function public.get_active_strike_points(uuid)                                     to service_role;
grant execute on function public.get_user_reputation(uuid)                                          to service_role;
grant execute on function public.calculate_reach_coefficient(uuid)                                  to service_role;
grant execute on function public.decide_moderation_case(uuid, text, boolean, uuid, text, text)      to service_role;
grant execute on function public.file_report_for(uuid, uuid, text, text[])                          to service_role;
grant execute on function public.file_appeal_for(uuid, uuid, text)                                  to service_role;
grant execute on function public.sweep_expired_strikes()                                            to service_role;
grant execute on function public.purge_report_identities()                                          to service_role;
grant execute on function public.purge_orphaned_moderation()                                        to service_role;
grant execute on function public.security_definer_functions_without_search_path()                  to service_role;
grant execute on function public.client_callable_definer_functions()                                to service_role;

grant execute on function public.get_my_role()                                                      to authenticated, service_role;
grant execute on function public.get_my_strike_count()                                              to authenticated, service_role;
grant execute on function public.file_report(uuid, text, text[])                                    to authenticated, service_role;
grant execute on function public.file_appeal(uuid, text)                                            to authenticated, service_role;

-- ===========================================================================
-- Scheduled jobs (only when pg_cron is installed)
-- ===========================================================================

do $$
declare
  v_job record;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    return;
  end if;

  for v_job in
    select * from (values
      ('modqueue_sweep_strikes',           '15 4 * * *', 'select public.sweep_expired_strikes()'),
      ('modqueue_purge_report_identities', '30 4 * * *', 'select public.purge_report_identities()'),
      ('modqueue_purge_orphans',           '45 4 * * *', 'select public.purge_orphaned_moderation()')
    ) as j(name, schedule, command)
  loop
    if exists (select 1 from cron.job where jobname = v_job.name) then
      perform cron.unschedule(v_job.name);
    end if;
    perform cron.schedule(v_job.name, v_job.schedule, v_job.command);
  end loop;
end;
$$;
