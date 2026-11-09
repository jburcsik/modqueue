import { randomUUID } from 'node:crypto'
import { systemClock } from './clock.js'
import { defaultConfig, type ModerationConfig } from './config.js'
import { slidingWindow } from './rate-limit.js'
import { computeReach } from './reach.js'
import type { Clock, ModerationStore, Notifier } from './store.js'
import {
  ModerationError,
  type AppealRow,
  type CaseRow,
  type ContentRow,
  type ContentState,
  type DecideCaseInput,
  type DecideCaseResult,
  type EventRow,
  type FileReportInput,
  type ModerationEventInput,
  type QueueItem,
  type ReportRow,
  type ReputationInputs,
  type RoleRow,
  type Settings,
  type StrikeRow,
} from './types.js'

export interface MemoryUser {
  id: string
  createdAt: string
}

export interface InMemoryStore extends ModerationStore {
  addUser(user: MemoryUser): void
  addContent(content: { id?: string; ownerId: string; body?: string | null; createdAt?: string; moderationState?: ContentState }): ContentRow
  getContent(contentId: string): ContentRow | null
  setReputation(row: ReputationInputs): void
  setRole(row: RoleRow): void
  allEvents(): EventRow[]
}

/** A notifier that records nothing and never throws. */
export const noopNotifier: Notifier = {
  onTierEscalated: async () => {},
  onAppealResolved: async () => {},
  onContentApproved: async () => {},
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

/**
 * Every `ModerationStore` method on Maps, with the invariants the SQL
 * contract enforces: one open case per target, a `held` state opens a case,
 * one open report per reporter per target, one pending appeal per strike,
 * and the report and appeal guards in order.
 */
export function createInMemoryStore(clock: Clock = systemClock, config: ModerationConfig = defaultConfig): InMemoryStore {
  const users = new Map<string, MemoryUser>()
  const content = new Map<string, ContentRow>()
  const settingsRow: Settings = clone(config.settings)
  const events: EventRow[] = []
  const strikes = new Map<string, StrikeRow>()
  const cases = new Map<string, CaseRow>()
  const reports = new Map<string, ReportRow>()
  const appeals = new Map<string, AppealRow>()
  const reputations = new Map<string, ReputationInputs>()
  const roles = new Map<string, RoleRow>()
  const rateEntries = new Map<string, number[]>()

  const nowIso = () => new Date(clock.now()).toISOString()

  function strikeActive(strike: StrikeRow): boolean {
    return strike.revokedAt === null && (strike.expiresAt === null || Date.parse(strike.expiresAt) > clock.now())
  }

  function activePoints(userId: string): number {
    let total = 0
    for (const strike of strikes.values()) if (strike.userId === userId && strikeActive(strike)) total += strike.points
    return total
  }

  function openCaseRow(contentId: string): CaseRow | null {
    for (const row of cases.values()) {
      if (row.targetId === contentId && (row.state === 'open' || row.state === 'claimed')) return row
    }
    return null
  }

  function ensureOpenCase(contentId: string): CaseRow {
    const existing = openCaseRow(contentId)
    if (existing) return existing
    const row: CaseRow = { id: randomUUID(), targetId: contentId, state: 'open', claimedBy: null, claimedAt: null, decidedAt: null, decision: null, createdAt: nowIso() }
    cases.set(row.id, row)
    return row
  }

  function reachFor(userId: string) {
    if (!settingsRow.reachEnabled) return null
    return computeReach({ reputation: reputations.get(userId) ?? null, activeStrikePoints: activePoints(userId), nowMs: clock.now() }, config)
  }

  async function checkRateLimit(key: string, windowSeconds: number, max: number): Promise<boolean> {
    const result = slidingWindow(rateEntries.get(key) ?? [], clock.now(), windowSeconds, max)
    rateEntries.set(key, result.timestamps)
    return result.allowed
  }

  function reportsOn(contentId: string): ReportRow[] {
    return [...reports.values()].filter((r) => r.targetId === contentId).sort((a, b) => b.trustWeight - a.trustWeight)
  }

  function pushEvent(event: ModerationEventInput): string {
    const row: EventRow = { ...clone(event), id: randomUUID(), createdAt: nowIso() }
    events.push(row)
    return row.id
  }

  function eventsOn(targetType: EventRow['targetType'], targetId: string): EventRow[] {
    return events.filter((e) => e.targetType === targetType && e.targetId === targetId).reverse()
  }

  function insertReport(input: FileReportInput): string {
    const target = content.get(input.targetId)
    if (!target || target.moderationState !== 'visible') throw new ModerationError('not_found', `content ${input.targetId}`)
    if (target.ownerId === input.reporterId) throw new ModerationError('self_report')
    if (
      (input.reason !== null && input.reason.length > config.reports.reasonMaxChars) ||
      input.evidencePaths.length > config.reports.maxEvidencePaths ||
      input.evidencePaths.some((p) => p.length > config.reports.evidencePathMaxChars || !config.reports.evidencePathPattern.test(p))
    ) {
      throw new ModerationError('invalid_input')
    }
    for (const report of reports.values()) {
      if (report.reporterId === input.reporterId && report.targetId === input.targetId && report.state === 'open') {
        throw new ModerationError('duplicate_report')
      }
    }
    const trustWeight = reachFor(input.reporterId)?.coefficient ?? 1
    const caseRow = ensureOpenCase(input.targetId)
    const row: ReportRow = {
      id: randomUUID(),
      caseId: caseRow.id,
      targetId: input.targetId,
      reporterId: input.reporterId,
      reason: input.reason,
      evidencePaths: [...input.evidencePaths],
      trustWeight,
      state: 'open',
      createdAt: nowIso(),
      resolvedAt: null,
    }
    reports.set(row.id, row)
    const openWeight = reportsOn(input.targetId).filter((r) => r.state === 'open').reduce((sum, r) => sum + r.trustWeight, 0)
    if (openWeight >= settingsRow.autoHideWeight && target.moderationState === 'visible') {
      target.moderationState = 'held'
      pushEvent({
        targetType: 'content',
        targetId: input.targetId,
        eventType: 'content_hold',
        source: 'system',
        severity: 'warning',
        summary: 'Held: open report weight reached the auto hide threshold',
        details: { reason: 'auto_hide', weight_sum: openWeight, threshold: settingsRow.autoHideWeight },
        actorId: null,
        caseId: caseRow.id,
        priorState: 'visible',
      })
    }
    return row.id
  }

  return {
    addUser(user) {
      users.set(user.id, user)
    },
    addContent(input) {
      const row: ContentRow = {
        id: input.id ?? randomUUID(),
        ownerId: input.ownerId,
        moderationState: input.moderationState ?? 'visible',
        createdAt: input.createdAt ?? nowIso(),
        body: input.body ?? null,
      }
      content.set(row.id, row)
      if (row.moderationState === 'held') ensureOpenCase(row.id)
      return clone(row)
    },
    getContent: (contentId) => clone(content.get(contentId) ?? null),
    setReputation(row) {
      reputations.set(row.user_id, row)
    },
    setRole(row) {
      roles.set(row.userId, row)
    },
    allEvents: () => clone(events),

    loadSettings: async () => clone(settingsRow),
    async saveSettings(patch, actorId) {
      const next = { ...settingsRow, ...patch, updatedAt: nowIso(), updatedBy: actorId }
      if (next.automationLevel === 'full_auto' && !next.fullAutoAcknowledgedAt) {
        throw new ModerationError('invalid_input', 'full_auto needs an acknowledgement')
      }
      Object.assign(settingsRow, next)
      return clone(settingsRow)
    },

    insertEvent: async (event) => pushEvent(event),
    listEvents: async (targetType, targetId, limit) => clone(eventsOn(targetType, targetId).slice(0, limit)),
    getEvent: async (eventId) => clone(events.find((e) => e.id === eventId) ?? null),
    recentUserLookup: async (actorId, targetUserId, sinceIso) =>
      events.some(
        (e) => e.eventType === 'user_lookup' && e.targetType === 'user' && e.targetId === targetUserId && e.actorId === actorId && e.createdAt >= sinceIso,
      ),

    async insertStrike(strike) {
      if (strike.points < config.strikes.pointsMin || strike.points > config.strikes.pointsMax) return null
      const row: StrikeRow = { ...strike, id: randomUUID(), revokedAt: null, revokedBy: null, createdAt: nowIso() }
      strikes.set(row.id, row)
      return row.id
    },
    getStrike: async (strikeId) => clone(strikes.get(strikeId) ?? null),
    async revokeStrike(strikeId, revokedBy) {
      const row = strikes.get(strikeId)
      if (!row || row.revokedAt !== null) return null
      row.revokedAt = nowIso()
      row.revokedBy = revokedBy
      return clone(row)
    },
    activeStrikePoints: async (userId) => activePoints(userId),
    activeStrikeCount: async (userId) => [...strikes.values()].filter((s) => s.userId === userId && strikeActive(s)).length,

    reputationInputs: async (userId) => clone(reputations.get(userId) ?? null),

    checkRateLimit,

    async setContentState(contentId, state) {
      const row = content.get(contentId)
      if (!row) return null
      const prior = row.moderationState
      row.moderationState = state
      if (state === 'held') ensureOpenCase(contentId)
      return prior
    },

    openCaseFor: async (contentId) => clone(openCaseRow(contentId)),
    getCase: async (caseId) => clone(cases.get(caseId) ?? null),
    openCase: async (contentId) => clone(ensureOpenCase(contentId)),
    async claimCase(caseId, moderatorId, force) {
      const row = cases.get(caseId)
      if (!row) throw new ModerationError('not_found', `case ${caseId}`)
      if (row.state !== 'open' && row.state !== 'claimed') throw new ModerationError('case_not_open')
      if (row.claimedBy && row.claimedBy !== moderatorId && !force) throw new ModerationError('case_claimed_by_other')
      row.claimedBy = moderatorId
      row.claimedAt = nowIso()
      row.state = 'claimed'
      return clone(row)
    },
    async releaseCase(caseId, moderatorId, force) {
      const row = cases.get(caseId)
      if (!row) throw new ModerationError('not_found', `case ${caseId}`)
      if (row.state !== 'open' && row.state !== 'claimed') throw new ModerationError('case_not_open')
      if (row.claimedBy && row.claimedBy !== moderatorId && !force) throw new ModerationError('forbidden')
      row.claimedBy = null
      row.claimedAt = null
      row.state = 'open'
      return clone(row)
    },
    async decideCase(input: DecideCaseInput): Promise<DecideCaseResult> {
      const row = cases.get(input.caseId)
      if (!row) throw new ModerationError('not_found', `case ${input.caseId}`)
      if (row.state === 'reversed' || (row.state === 'decided' && input.decision !== 'restore')) throw new ModerationError('case_not_open')
      const target = content.get(row.targetId)
      if (!target) throw new ModerationError('not_found', `content ${row.targetId}`)
      const priorState = target.moderationState
      if (input.decision === 'restore') {
        const later = [...cases.values()].some((c) => c.targetId === row.targetId && c.createdAt > row.createdAt)
        if (row.decision !== 'remove' || priorState !== 'removed' || later) throw new ModerationError('case_not_open')
      }
      target.moderationState = input.decision === 'remove' ? 'removed' : 'visible'
      let reportsResolved = 0
      for (const report of reports.values()) {
        if (report.caseId === row.id && report.state === 'open') {
          report.state = input.flagJustified === false ? 'rejected' : 'upheld'
          report.resolvedAt = nowIso()
          reportsResolved += 1
        }
      }
      row.state = input.decision === 'restore' ? 'reversed' : 'decided'
      row.decision = input.decision
      row.decidedAt = nowIso()
      const eventType = input.decision === 'keep' ? 'content_approve' : input.decision === 'remove' ? 'content_remove' : 'content_restore'
      const eventId = await this.insertEvent({
        targetType: 'content',
        targetId: row.targetId,
        eventType,
        source: input.source,
        severity: input.decision === 'remove' ? 'violation' : 'info',
        summary: input.reason,
        details: { decision: input.decision, flag_justified: input.flagJustified },
        actorId: input.actorId,
        caseId: row.id,
        priorState,
      })
      return { caseId: row.id, decision: input.decision, moderationState: target.moderationState, priorState, reportsResolved, eventId: eventId as string }
    },

    async fileReport(input) {
      const reporter = users.get(input.reporterId)
      const minAgeMs = settingsRow.reportMinAccountAgeHours * 60 * 60 * 1000
      if (!reporter || clock.now() - Date.parse(reporter.createdAt) < minAgeMs) throw new ModerationError('account_too_new')
      const rateKey = `report:${input.reporterId}`
      const slots = rateEntries.get(rateKey) ?? []
      if (!(await checkRateLimit(rateKey, settingsRow.reportRateWindowSeconds, settingsRow.reportRateMax))) {
        throw new ModerationError('rate_limited')
      }
      try {
        return insertReport(input)
      } catch (error) {
        // A refused report consumes no slot, as the SQL rollback does.
        rateEntries.set(rateKey, slots)
        throw error
      }
    },
    listReports: async (contentId) => clone(reportsOn(contentId)),
    async resolveReport(reportId, state, actorId) {
      const row = reports.get(reportId)
      if (!row || row.state !== 'open') throw new ModerationError('not_found', `open report ${reportId}`)
      row.state = state
      row.resolvedAt = nowIso()
      void actorId
      return clone(row)
    },

    async fileAppeal(input) {
      const strike = strikes.get(input.strikeId)
      if (!strike) throw new ModerationError('not_found', `strike ${input.strikeId}`)
      if (strike.userId !== input.userId) throw new ModerationError('not_strike_owner')
      if (!strikeActive(strike)) throw new ModerationError('strike_inactive')
      if (!(await checkRateLimit(`appeal:${input.userId}`, settingsRow.appealRateWindowSeconds, settingsRow.appealRateMax))) {
        throw new ModerationError('rate_limited')
      }
      if (input.statement.length < config.appeals.statementMinChars || input.statement.length > config.appeals.statementMaxChars) {
        throw new ModerationError('invalid_input')
      }
      for (const appeal of appeals.values()) {
        if (appeal.strikeId === input.strikeId && appeal.state === 'pending') throw new ModerationError('duplicate_appeal')
      }
      const row: AppealRow = {
        id: randomUUID(),
        userId: input.userId,
        strikeId: input.strikeId,
        moderationEventId: strike.moderationEventId,
        statement: input.statement,
        state: 'pending',
        resolvedBy: null,
        resolvedAt: null,
        reviewerNote: null,
        createdAt: nowIso(),
      }
      appeals.set(row.id, row)
      await this.insertEvent({
        targetType: 'user',
        targetId: input.userId,
        eventType: 'appeal_filed',
        source: 'member',
        severity: 'info',
        summary: null,
        details: { appeal_id: row.id, strike_id: row.strikeId },
        actorId: input.userId,
        caseId: null,
        priorState: null,
      })
      return row.id
    },
    listAppeals: async (state, limit) =>
      clone([...appeals.values()].filter((a) => a.state === state).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, limit)),
    getAppeal: async (appealId) => clone(appeals.get(appealId) ?? null),
    async resolveAppeal(appealId, resolution, resolvedBy, reviewerNote) {
      const row = appeals.get(appealId)
      if (!row) throw new ModerationError('not_found', `appeal ${appealId}`)
      if (row.state !== 'pending') throw new ModerationError('appeal_not_pending')
      row.state = resolution === 'uphold' ? 'upheld' : 'overturned'
      row.resolvedBy = resolvedBy
      row.resolvedAt = nowIso()
      row.reviewerNote = reviewerNote
      return clone(row)
    },

    async readQueue(options) {
      if (options.ownerId !== null && !options.includeIdentity) throw new ModerationError('forbidden', 'owner filter needs identity')
      const items: QueueItem[] = []
      for (const row of cases.values()) {
        const matches =
          options.filter === 'open'
            ? row.state === 'open'
            : options.filter === 'claimed'
              ? row.state === 'claimed'
              : options.filter === 'mine'
                ? row.claimedBy === options.callerId && row.state === 'claimed'
                : row.state === 'decided' || row.state === 'reversed'
        if (!matches) continue
        const target = content.get(row.targetId)
        if (!target) continue
        if (options.ownerId !== null && target.ownerId !== options.ownerId) continue
        const caseReports = reportsOn(row.targetId).filter((r) => r.caseId === row.id)
        const openReportCount = caseReports.filter((r) => r.state === 'open').length
        const identity = options.includeIdentity
        items.push({
          caseId: row.id,
          caseState: row.state,
          claimedBy: row.claimedBy,
          claimedAt: row.claimedAt,
          caseCreatedAt: row.createdAt,
          contentId: target.id,
          ownerId: identity ? target.ownerId : null,
          ownerDisplayName: identity ? (roles.get(target.ownerId)?.displayName ?? null) : null,
          moderationState: target.moderationState,
          contentCreatedAt: target.createdAt,
          preview: target.body === null ? null : target.body.slice(0, 240),
          openReportCount,
          totalReportCount: caseReports.length,
          reports: clone(caseReports).map((r) => (identity ? r : { ...r, reporterId: null })),
          events: clone(eventsOn('content', target.id)).map((e) => (identity || (e.source !== 'member' && e.source !== 'system') ? e : { ...e, actorId: null })),
          ownerStrikePoints: activePoints(target.ownerId),
          ownerReach: reachFor(target.ownerId),
          priority: target.moderationState === 'held' ? 1 : openReportCount >= 2 ? 2 : 3,
        })
      }
      items.sort((a, b) => a.priority - b.priority || a.caseCreatedAt.localeCompare(b.caseCreatedAt))
      return items.slice(0, options.limit)
    },

    getRole: async (userId) => roles.get(userId)?.role ?? null,
    listRoles: async (userIds) => clone(userIds.flatMap((id) => (roles.has(id) ? [roles.get(id) as RoleRow] : []))),
  }
}
