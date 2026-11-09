// Supabase implementation of ModerationStore.
//
// Runs with a service-role client. Every table, view and function it touches
// is named in docs/contract.md. SQL guard errors (SQLSTATE MQ001 to MQ017)
// become ModerationError codes; every other database error becomes
// `store_error` with the message kept for logs.

import type { SupabaseClient } from '@supabase/supabase-js'
import { defaultConfig } from '../config.js'
import type { ModerationStore } from '../store.js'
import {
  ERROR_CODES,
  ModerationError,
  type AppealResolution,
  type AppealRow,
  type AppealState,
  type CaseRow,
  type ContentState,
  type DecideCaseInput,
  type DecideCaseResult,
  type EventRow,
  type FileAppealInput,
  type FileReportInput,
  type ModerationErrorCode,
  type ModerationEventInput,
  type QueueItem,
  type ReachResult,
  type ReadQueueOptions,
  type ReportRow,
  type ReportState,
  type ReputationInputs,
  type Role,
  type RoleRow,
  type Settings,
  type StrikeInput,
  type StrikeRow,
  type TargetType,
} from '../types.js'
import { shapeQueueItems } from './queue.js'

export interface SupabaseStoreOptions {
  /** Receives every swallowed failure (audit inserts, rate-limit checks, reach reads). Defaults to console.error. */
  onError?: (context: string, error: unknown) => void
}

/** ModerationStore plus the reach read the queue needs. */
export interface SupabaseStore extends ModerationStore {
  /** `calculate_reach_coefficient(p_user_id)` mapped to ReachResult; an RPC failure yields coefficient 1.0 with `error: true`. */
  reachCoefficient(userId: string): Promise<ReachResult>
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const SQLSTATE_TO_CODE: Record<string, ModerationErrorCode> = {
  MQ001: 'unauthenticated',
  MQ002: 'forbidden',
  MQ003: 'not_found',
  MQ004: 'invalid_input',
  MQ005: 'rate_limited',
  MQ006: 'account_too_new',
  MQ007: 'self_report',
  MQ008: 'duplicate_report',
  MQ009: 'duplicate_appeal',
  MQ010: 'not_strike_owner',
  MQ011: 'strike_inactive',
  MQ012: 'appeal_not_pending',
  MQ013: 'case_not_open',
  MQ014: 'case_claimed_by_other',
  MQ015: 'posting_paused',
  MQ016: 'content_blocked',
  MQ017: 'store_error',
}

const UNIQUE_VIOLATION = '23505'
const CHECK_VIOLATION = '23514'

interface DbError {
  code?: string | null
  message?: string | null
  details?: string | null
}

/** A PostgREST error as a ModerationError. */
export function mapDbError(error: DbError): ModerationError {
  const byState = error.code ? SQLSTATE_TO_CODE[error.code] : undefined
  if (byState) return new ModerationError(byState, error.message ?? undefined, { cause: error })
  if (error.code === CHECK_VIOLATION) {
    return new ModerationError('invalid_input', error.message ?? 'check constraint violated', { cause: error })
  }
  if (error.code === UNIQUE_VIOLATION) {
    return new ModerationError('invalid_input', 'a row with these values already exists', { cause: error })
  }
  const message = error.message ?? ''
  if ((ERROR_CODES as ReadonlyArray<string>).includes(message)) {
    return new ModerationError(message as ModerationErrorCode, undefined, { cause: error })
  }
  return new ModerationError('store_error', message || 'database error', { cause: error })
}

// ---------------------------------------------------------------------------
// Row mapping (snake_case columns to the camelCase row types)
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>

function toCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

function toSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())
}

function fromRow<T>(row: Raw): T {
  const out: Raw = {}
  for (const [key, value] of Object.entries(row)) out[toCamel(key)] = value
  return out as T
}

function toRow(input: Raw): Raw {
  const out: Raw = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[toSnake(key)] = value
  }
  return out
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}

function reportFromRow(row: Raw): ReportRow {
  const report = fromRow<ReportRow>(row)
  return { ...report, trustWeight: num(row.trust_weight, 1), evidencePaths: (row.evidence_paths as string[] | null) ?? [] }
}

function settingsFromRow(row: Raw): Settings {
  const s = fromRow<Settings>(row)
  return {
    automationLevel: s.automationLevel,
    warnThreshold: num(row.warn_threshold, defaultConfig.settings.warnThreshold),
    holdThreshold: num(row.hold_threshold, defaultConfig.settings.holdThreshold),
    autoActionConfidence: num(row.auto_action_confidence, defaultConfig.settings.autoActionConfidence),
    autoWarnKeywords: s.autoWarnKeywords ?? [],
    autoBlockKeywords: s.autoBlockKeywords ?? [],
    fullAutoAcknowledgedAt: s.fullAutoAcknowledgedAt ?? null,
    autoHideWeight: num(row.auto_hide_weight, defaultConfig.settings.autoHideWeight),
    reportMinAccountAgeHours: s.reportMinAccountAgeHours,
    reportRateMax: s.reportRateMax,
    reportRateWindowSeconds: s.reportRateWindowSeconds,
    appealRateMax: s.appealRateMax,
    appealRateWindowSeconds: s.appealRateWindowSeconds,
    reportIdentityRetentionDays: s.reportIdentityRetentionDays,
    reachEnabled: s.reachEnabled,
    updatedAt: s.updatedAt ?? null,
    updatedBy: s.updatedBy ?? null,
  }
}

const NEUTRAL_FACTORS = { age: 1, reputation: 1, strikes: 1, engagement: 1, farReport: 1 }

function reachFromRow(row: Raw | null): ReachResult {
  if (!row) return reachError()
  const factor = (key: string) => num(row[key], 1)
  const rawFar = row.far_rate
  return {
    coefficient: num(row.coefficient, 1),
    enabled: row.enabled !== false,
    error: false,
    factors: {
      age: factor('age_factor'),
      reputation: factor('reputation_factor'),
      strikes: factor('strike_factor'),
      engagement: factor('engagement_factor'),
      farReport: factor('far_report_factor'),
    },
    inputs: {
      accountAgeHours: num(row.account_age_hours, 0),
      reputationScore: num(row.reputation_score, 0),
      activeStrikePoints: num(row.active_strike_points, 0),
      posts: num(row.posts, 0),
      endorsedPosts: num(row.endorsed_posts, 0),
      endorsementsGiven: num(row.endorsements_given, 0),
      reportsReceived: num(row.reports_received, 0),
      farRate: rawFar === null || rawFar === undefined ? null : num(rawFar, 0),
    },
  }
}

function reachError(): ReachResult {
  return {
    coefficient: 1,
    enabled: true,
    error: true,
    factors: { ...NEUTRAL_FACTORS },
    inputs: {
      accountAgeHours: 0,
      reputationScore: 0,
      activeStrikePoints: 0,
      posts: 0,
      endorsedPosts: 0,
      endorsementsGiven: 0,
      reportsReceived: 0,
      farRate: null,
    },
  }
}

/** PostgREST returns a `returns table` function as an array and a composite as one object. */
function firstRow(data: unknown): Raw | null {
  if (Array.isArray(data)) return (data[0] as Raw | undefined) ?? null
  return data && typeof data === 'object' ? (data as Raw) : null
}

const ACTIVE_STRIKE_FILTER = (nowIso: string) => `expires_at.is.null,expires_at.gt.${nowIso}`

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSupabaseStore(client: SupabaseClient, options: SupabaseStoreOptions = {}): SupabaseStore {
  const onError = options.onError ?? ((context: string, error: unknown) => console.error(`[modqueue] ${context}`, error))

  /** Throws the mapped error for a failed query; returns the data otherwise. */
  function unwrap<T>(result: { data: T | null; error: DbError | null }): T | null {
    if (result.error) throw mapDbError(result.error)
    return result.data
  }

  async function readCase(caseId: string): Promise<CaseRow | null> {
    const data = unwrap(await client.from('moderation_cases').select('*').eq('id', caseId).maybeSingle())
    return data ? fromRow<CaseRow>(data as Raw) : null
  }

  async function openCaseFor(contentId: string): Promise<CaseRow | null> {
    const data = unwrap(
      await client.from('moderation_cases').select('*').eq('target_id', contentId).in('state', ['open', 'claimed']).limit(1).maybeSingle(),
    )
    return data ? fromRow<CaseRow>(data as Raw) : null
  }

  async function getAppeal(appealId: string): Promise<AppealRow | null> {
    const data = unwrap(await client.from('moderation_appeals').select('*').eq('id', appealId).maybeSingle())
    return data ? fromRow<AppealRow>(data as Raw) : null
  }

  /** Why a conditional claim or release update touched no row. */
  async function explainCaseMiss(caseId: string, moderatorId: string, otherCode: ModerationErrorCode): Promise<never> {
    const row = await readCase(caseId)
    if (!row) throw new ModerationError('not_found', `case ${caseId}`)
    if (row.state !== 'open' && row.state !== 'claimed') throw new ModerationError('case_not_open', `case ${caseId} is ${row.state}`)
    if (row.claimedBy && row.claimedBy !== moderatorId) throw new ModerationError(otherCode, `case ${caseId} is claimed by another moderator`)
    throw new ModerationError('store_error', `case ${caseId} could not be updated`)
  }

  async function activeStrikePoints(userId: string): Promise<number> {
    const data = unwrap(await client.rpc('get_active_strike_points', { p_user_id: userId }))
    return num(data, 0)
  }

  async function reachCoefficient(userId: string): Promise<ReachResult> {
    const result = await client.rpc('calculate_reach_coefficient', { p_user_id: userId })
    if (result.error) {
      onError('reachCoefficient', result.error)
      return reachError()
    }
    return reachFromRow(firstRow(result.data))
  }

  async function listRoles(userIds: string[]): Promise<RoleRow[]> {
    if (userIds.length === 0) return []
    const data = unwrap(await client.from('moderation_roles').select('user_id, role, display_name').in('user_id', userIds))
    return ((data ?? []) as Raw[]).map((row) => fromRow<RoleRow>(row))
  }

  async function insertEvent(event: ModerationEventInput): Promise<string | null> {
    const result = await client.from('moderation_events').insert(toRow(event as unknown as Raw)).select('id').single()
    if (result.error) {
      onError('insertEvent', result.error)
      return null
    }
    return (result.data as Raw).id as string
  }

  return {
    // Settings

    async loadSettings() {
      const data = unwrap(await client.from('moderation_settings').select('*').eq('id', 'default').maybeSingle())
      return data ? settingsFromRow(data as Raw) : { ...defaultConfig.settings }
    },

    async saveSettings(patch, actorId) {
      const fields = toRow(patch as Raw)
      delete fields.updated_at
      delete fields.updated_by
      const values = { ...fields, updated_at: new Date().toISOString(), updated_by: actorId }
      const updated = unwrap(await client.from('moderation_settings').update(values).eq('id', 'default').select('*').maybeSingle())
      if (updated) return settingsFromRow(updated as Raw)
      const inserted = unwrap(
        await client.from('moderation_settings').insert({ id: 'default', ...values }, { defaultToNull: false }).select('*').single(),
      )
      return settingsFromRow(inserted as unknown as Raw)
    },

    // Events

    insertEvent,

    async listEvents(targetType: TargetType, targetId: string, limit: number) {
      const data = unwrap(
        await client
          .from('moderation_events')
          .select('*')
          .eq('target_type', targetType)
          .eq('target_id', targetId)
          .order('created_at', { ascending: false })
          .limit(limit),
      )
      return ((data ?? []) as Raw[]).map((row) => fromRow<EventRow>(row))
    },

    async getEvent(eventId) {
      const data = unwrap(await client.from('moderation_events').select('*').eq('id', eventId).maybeSingle())
      return data ? fromRow<EventRow>(data as Raw) : null
    },

    async recentUserLookup(actorId, targetUserId, sinceIso) {
      const data = unwrap(
        await client
          .from('moderation_events')
          .select('id')
          .eq('event_type', 'user_lookup')
          .eq('target_type', 'user')
          .eq('target_id', targetUserId)
          .eq('actor_id', actorId)
          .gte('created_at', sinceIso)
          .limit(1),
      )
      return (data ?? []).length > 0
    },

    // Strikes

    async insertStrike(strike: StrikeInput) {
      const result = await client.from('user_strikes').insert(toRow(strike as unknown as Raw)).select('id').single()
      if (result.error) {
        onError('insertStrike', result.error)
        return null
      }
      return (result.data as Raw).id as string
    },

    async getStrike(strikeId) {
      const data = unwrap(await client.from('user_strikes').select('*').eq('id', strikeId).maybeSingle())
      return data ? fromRow<StrikeRow>(data as Raw) : null
    },

    async revokeStrike(strikeId, revokedBy) {
      const data = unwrap(
        await client
          .from('user_strikes')
          .update({ revoked_at: new Date().toISOString(), revoked_by: revokedBy })
          .eq('id', strikeId)
          .is('revoked_at', null)
          .select('*')
          .maybeSingle(),
      )
      return data ? fromRow<StrikeRow>(data as Raw) : null
    },

    activeStrikePoints,

    async activeStrikeCount(userId) {
      const result = await client
        .from('user_strikes')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .is('revoked_at', null)
        .or(ACTIVE_STRIKE_FILTER(new Date().toISOString()))
      if (result.error) throw mapDbError(result.error)
      return result.count ?? 0
    },

    // Reach

    async reputationInputs(userId) {
      const data = unwrap(await client.from('moderation_reputation_inputs').select('*').eq('user_id', userId).maybeSingle())
      if (!data) return null
      const row = data as Raw
      return {
        user_id: row.user_id as string,
        account_created_at: row.account_created_at as string,
        posts: num(row.posts, 0),
        endorsed_posts: num(row.endorsed_posts, 0),
        endorsements_given: num(row.endorsements_given, 0),
        reports_received: num(row.reports_received, 0),
        far_rate: row.far_rate === null || row.far_rate === undefined ? null : num(row.far_rate, 0),
      } satisfies ReputationInputs
    },

    reachCoefficient,

    // Rate limiting

    async checkRateLimit(key, windowSeconds, max) {
      try {
        const result = await client.rpc('check_rate_limit', { p_key: key, p_window_seconds: windowSeconds, p_max: max })
        if (result.error) {
          onError('checkRateLimit', result.error)
          return false
        }
        return result.data === true
      } catch (error) {
        onError('checkRateLimit', error)
        return false
      }
    },

    // Content

    async setContentState(contentId, state: ContentState) {
      const current = unwrap(await client.from('moderation_content').select('moderation_state').eq('id', contentId).maybeSingle())
      if (!current) return null
      const prior = (current as Raw).moderation_state as ContentState
      unwrap(await client.from('moderation_content').update({ moderation_state: state }).eq('id', contentId))
      return prior
    },

    // Cases

    openCaseFor,

    getCase: readCase,

    async openCase(contentId) {
      const existing = await openCaseFor(contentId)
      if (existing) return existing
      const result = await client.from('moderation_cases').insert({ target_id: contentId, state: 'open' }).select('*').single()
      if (result.error?.code === UNIQUE_VIOLATION) {
        const raced = await openCaseFor(contentId)
        if (raced) return raced
      }
      return fromRow<CaseRow>(unwrap(result) as unknown as Raw)
    },

    async claimCase(caseId, moderatorId, force) {
      let query = client
        .from('moderation_cases')
        .update({ claimed_by: moderatorId, claimed_at: new Date().toISOString(), state: 'claimed' })
        .eq('id', caseId)
        .in('state', ['open', 'claimed'])
      if (!force) query = query.or(`claimed_by.is.null,claimed_by.eq.${moderatorId}`)
      const data = unwrap(await query.select('*').maybeSingle())
      if (!data) return explainCaseMiss(caseId, moderatorId, 'case_claimed_by_other')
      return fromRow<CaseRow>(data as Raw)
    },

    async releaseCase(caseId, moderatorId, force) {
      let query = client
        .from('moderation_cases')
        .update({ claimed_by: null, claimed_at: null, state: 'open' })
        .eq('id', caseId)
        .in('state', ['open', 'claimed'])
      if (!force) query = query.or(`claimed_by.is.null,claimed_by.eq.${moderatorId}`)
      const data = unwrap(await query.select('*').maybeSingle())
      if (!data) return explainCaseMiss(caseId, moderatorId, 'forbidden')
      return fromRow<CaseRow>(data as Raw)
    },

    async decideCase(input: DecideCaseInput) {
      const data = unwrap(
        await client.rpc('decide_moderation_case', {
          p_case_id: input.caseId,
          p_decision: input.decision,
          p_flag_justified: input.flagJustified,
          p_actor_id: input.actorId,
          p_source: input.source,
          p_reason: input.reason,
        }),
      )
      const row = firstRow(data)
      if (!row) throw new ModerationError('store_error', 'decide_moderation_case returned no row')
      return {
        caseId: row.case_id as string,
        decision: row.decision as DecideCaseResult['decision'],
        moderationState: row.moderation_state as ContentState,
        priorState: row.prior_state as ContentState,
        reportsResolved: num(row.reports_resolved, 0),
        eventId: row.event_id as string,
      }
    },

    // Reports

    async fileReport(input: FileReportInput) {
      const data = unwrap(
        await client.rpc('file_report_for', {
          p_reporter_id: input.reporterId,
          p_target_id: input.targetId,
          p_reason: input.reason,
          p_evidence_paths: input.evidencePaths,
        }),
      )
      return String(data)
    },

    async listReports(contentId) {
      const data = unwrap(
        await client.from('moderation_reports').select('*').eq('target_id', contentId).order('trust_weight', { ascending: false }),
      )
      return ((data ?? []) as Raw[]).map(reportFromRow)
    },

    async resolveReport(reportId, state: Extract<ReportState, 'duplicate' | 'withdrawn'>, actorId) {
      const data = unwrap(
        await client
          .from('moderation_reports')
          .update({ state, resolved_at: new Date().toISOString() })
          .eq('id', reportId)
          .eq('state', 'open')
          .select('*')
          .maybeSingle(),
      )
      if (!data) throw new ModerationError('not_found', `open report ${reportId}`)
      const report = reportFromRow(data as Raw)
      await insertEvent({
        targetType: 'content',
        targetId: report.targetId,
        eventType: 'mod_note',
        source: actorId ? 'moderator' : 'system',
        severity: 'info',
        summary: `Report marked ${state}`,
        details: { report_id: reportId, report_state: state },
        actorId,
        caseId: report.caseId,
        priorState: null,
      })
      return report
    },

    // Appeals

    async fileAppeal(input: FileAppealInput) {
      const data = unwrap(
        await client.rpc('file_appeal_for', { p_user_id: input.userId, p_strike_id: input.strikeId, p_statement: input.statement }),
      )
      return String(data)
    },

    async listAppeals(state: AppealState, limit) {
      const data = unwrap(
        await client.from('moderation_appeals').select('*').eq('state', state).order('created_at', { ascending: true }).limit(limit),
      )
      return ((data ?? []) as Raw[]).map((row) => fromRow<AppealRow>(row))
    },

    getAppeal,

    async resolveAppeal(appealId, resolution: AppealResolution, resolvedBy, reviewerNote) {
      const state: AppealState = resolution === 'uphold' ? 'upheld' : 'overturned'
      const data = unwrap(
        await client
          .from('moderation_appeals')
          .update({ state, resolved_by: resolvedBy, resolved_at: new Date().toISOString(), reviewer_note: reviewerNote })
          .eq('id', appealId)
          .eq('state', 'pending')
          .select('*')
          .maybeSingle(),
      )
      if (data) return fromRow<AppealRow>(data as Raw)
      const existing = await getAppeal(appealId)
      if (!existing) throw new ModerationError('not_found', `appeal ${appealId}`)
      throw new ModerationError('appeal_not_pending', `appeal ${appealId} is ${existing.state}`)
    },

    // Queue

    async readQueue(options: ReadQueueOptions) {
      if (options.ownerId && !options.includeIdentity) {
        throw new ModerationError('forbidden', 'owner filter requires identity access')
      }
      let query = client.from('moderation_queue').select('*')
      switch (options.filter) {
        case 'open':
          query = query.eq('case_state', 'open')
          break
        case 'claimed':
          query = query.eq('case_state', 'claimed')
          break
        case 'mine':
          query = query.eq('case_state', 'claimed').eq('claimed_by', options.callerId)
          break
        case 'decided':
          query = query.in('case_state', ['decided', 'reversed'])
          break
      }
      if (options.ownerId) query = query.eq('owner_id', options.ownerId)
      const rows = ((unwrap(await query.order('case_created_at', { ascending: true }).limit(options.limit)) ?? []) as Raw[])
      if (rows.length === 0) return []

      const contentIds = rows.map((row) => row.content_id as string)
      const ownerIds = [...new Set(rows.map((row) => row.owner_id as string))]

      const [reportRows, eventRows, roles, ownerStats] = await Promise.all([
        client.from('moderation_reports').select('*').in('target_id', contentIds).order('trust_weight', { ascending: false }),
        client
          .from('moderation_events')
          .select('*')
          .eq('target_type', 'content')
          .in('target_id', contentIds)
          .order('created_at', { ascending: false }),
        options.includeIdentity ? listRoles(ownerIds) : Promise.resolve([] as RoleRow[]),
        Promise.all(
          ownerIds.map(async (ownerId) => ({
            ownerId,
            points: await activeStrikePoints(ownerId),
            reach: await reachCoefficient(ownerId),
          })),
        ),
      ])
      const reports = ((unwrap(reportRows) ?? []) as Raw[]).map(reportFromRow)
      const events = ((unwrap(eventRows) ?? []) as Raw[]).map((row) => fromRow<EventRow>(row))
      const nameByOwner = new Map(roles.map((role) => [role.userId, role.displayName]))
      const statsByOwner = new Map(ownerStats.map((stat) => [stat.ownerId, stat]))

      const items: QueueItem[] = rows.map((row) => {
        const contentId = row.content_id as string
        const ownerId = row.owner_id as string
        const openReportCount = num(row.open_report_count, 0)
        const moderationState = row.moderation_state as ContentState
        return {
          caseId: row.case_id as string,
          caseState: row.case_state as QueueItem['caseState'],
          claimedBy: (row.claimed_by as string | null) ?? null,
          claimedAt: (row.claimed_at as string | null) ?? null,
          caseCreatedAt: row.case_created_at as string,
          contentId,
          ownerId,
          ownerDisplayName: nameByOwner.get(ownerId) ?? null,
          moderationState,
          contentCreatedAt: row.content_created_at as string,
          preview: (row.preview as string | null) ?? null,
          openReportCount,
          totalReportCount: num(row.total_report_count, 0),
          reports: reports.filter((report) => report.targetId === contentId),
          events: events.filter((event) => event.targetId === contentId),
          ownerStrikePoints: statsByOwner.get(ownerId)?.points ?? 0,
          ownerReach: statsByOwner.get(ownerId)?.reach ?? null,
          priority: moderationState === 'held' ? 1 : openReportCount >= 2 ? 2 : 3,
        }
      })
      items.sort((a, b) => a.priority - b.priority || a.caseCreatedAt.localeCompare(b.caseCreatedAt))
      return shapeQueueItems(items, options.includeIdentity)
    },

    // Roles

    async getRole(userId) {
      const data = unwrap(await client.from('moderation_roles').select('role').eq('user_id', userId).maybeSingle())
      return data ? ((data as Raw).role as Role) : null
    },

    listRoles,
  }
}
