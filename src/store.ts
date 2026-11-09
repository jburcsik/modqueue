// The four interfaces the core depends on, plus the server-side Authorizer.
//
// Every method documents its semantics, nullability and the SQL object that
// backs it in the Supabase implementation. The store runs with service-role
// credentials; member-facing identity checks happen inside the SQL functions
// it calls, never in the caller.

import type { ModerationConfig } from './config.js'
import type {
  AppealResolution,
  AppealRow,
  AppealState,
  CaseRow,
  ContentState,
  DecideCaseInput,
  DecideCaseResult,
  EventRow,
  FileAppealInput,
  FileReportInput,
  IssueType,
  ModerationEventInput,
  ModerationOutcome,
  NotificationPolicy,
  Principal,
  QueueItem,
  ReadQueueOptions,
  ReportRow,
  ReportState,
  ReputationInputs,
  Role,
  RoleRow,
  Settings,
  StockMessageKey,
  StrikeInput,
  StrikeRow,
  StrikeTier,
  TargetType,
} from './types.js'

// ---------------------------------------------------------------------------
// ModerationStore
// ---------------------------------------------------------------------------

export interface ModerationStore {
  // Settings

  /** The single settings row; `defaultConfig.settings` when the row is absent. Backed by `moderation_settings`. */
  loadSettings(): Promise<Settings>

  /** Merges `patch` into the row and returns it. Rejects `full_auto` without an acknowledgement (CHECK). Backed by `moderation_settings`. */
  saveSettings(patch: Partial<Settings>, actorId: string): Promise<Settings>

  // Events

  /** Appends one audit row and returns its id, or null when the insert failed. Backed by `moderation_events`. */
  insertEvent(event: ModerationEventInput): Promise<string | null>

  /** Events on one target, newest first. Backed by `moderation_events`. */
  listEvents(targetType: TargetType, targetId: string, limit: number): Promise<EventRow[]>

  /** One event by id, or null. Backed by `moderation_events`. */
  getEvent(eventId: string): Promise<EventRow | null>

  /** True when `actorId` already has a `user_lookup` event on `targetUserId` at or after `sinceIso`. Backed by `moderation_events`. */
  recentUserLookup(actorId: string, targetUserId: string, sinceIso: string): Promise<boolean>

  // Strikes

  /** Inserts a strike and returns its id, or null when the insert failed. Backed by `user_strikes`. */
  insertStrike(strike: StrikeInput): Promise<string | null>

  /** One strike by id, or null. Backed by `user_strikes`. */
  getStrike(strikeId: string): Promise<StrikeRow | null>

  /** Sets revoked_at and revoked_by; returns the row, or null when not found or already revoked. Backed by `user_strikes`. */
  revokeStrike(strikeId: string, revokedBy: string | null): Promise<StrikeRow | null>

  /** Sum of points on strikes that are neither revoked nor expired. Backed by `get_active_strike_points(p_user_id)`. */
  activeStrikePoints(userId: string): Promise<number>

  /** Number of strikes that are neither revoked nor expired. Backed by a count on `user_strikes`. */
  activeStrikeCount(userId: string): Promise<number>

  // Reach

  /** The host's reputation view row, or null when the user has none. Backed by `moderation_reputation_inputs`. */
  reputationInputs(userId: string): Promise<ReputationInputs | null>

  // Rate limiting

  /** True when the call is within budget and was recorded. False when over budget or on any error (fail closed). Backed by `check_rate_limit`. */
  checkRateLimit(key: string, windowSeconds: number, max: number): Promise<boolean>

  // Content

  /** Sets moderation_state and returns the prior state, or null when the row does not exist. Backed by `moderation_content`; a change to `held` opens a case by trigger. */
  setContentState(contentId: string, state: ContentState): Promise<ContentState | null>

  // Cases

  /** The open or claimed case for the content, or null. Backed by `moderation_cases`. */
  openCaseFor(contentId: string): Promise<CaseRow | null>

  /** One case by id, or null. Backed by `moderation_cases`. */
  getCase(caseId: string): Promise<CaseRow | null>

  /** Opens a case, or returns the existing open one. Backed by `moderation_cases` and the one-open-case index. */
  openCase(contentId: string): Promise<CaseRow>

  /** Sets claimed_by. Throws `case_not_open` when decided, `case_claimed_by_other` when held by another moderator unless `force`. Backed by `moderation_cases`. */
  claimCase(caseId: string, moderatorId: string, force: boolean): Promise<CaseRow>

  /** Clears claimed_by. Throws `case_not_open` when decided, `forbidden` when claimed by another moderator unless `force`. Backed by `moderation_cases`. */
  releaseCase(caseId: string, moderatorId: string, force: boolean): Promise<CaseRow>

  /** Content state, open reports, case closure and the audit row in one transaction. Throws `not_found` or `case_not_open`. Backed by `decide_moderation_case`. */
  decideCase(input: DecideCaseInput): Promise<DecideCaseResult>

  // Reports

  /** Files a report with every guard applied server-side; returns the report id. Throws the guard's code. Backed by `file_report_for`. */
  fileReport(input: FileReportInput): Promise<string>

  /** Reports on one content row, highest trust weight first. Backed by `moderation_reports`. */
  listReports(contentId: string): Promise<ReportRow[]>

  /** Manual resolution to `duplicate` or `withdrawn`. Throws `not_found` when the report is not open. Backed by `moderation_reports`. */
  resolveReport(reportId: string, state: Extract<ReportState, 'duplicate' | 'withdrawn'>, actorId: string | null): Promise<ReportRow>

  // Appeals

  /** Files an appeal with ownership, strike state and rate guards applied server-side; returns the appeal id. Backed by `file_appeal_for`. */
  fileAppeal(input: FileAppealInput): Promise<string>

  /** Appeals in one state, oldest first. Backed by `moderation_appeals`. */
  listAppeals(state: AppealState, limit: number): Promise<AppealRow[]>

  /** One appeal by id, or null. Backed by `moderation_appeals`. */
  getAppeal(appealId: string): Promise<AppealRow | null>

  /** Moves a pending appeal to upheld or overturned. Throws `appeal_not_pending`. Backed by `moderation_appeals`. */
  resolveAppeal(appealId: string, resolution: AppealResolution, resolvedBy: string, reviewerNote: string | null): Promise<AppealRow>

  // Queue

  /** Cases joined to content, reports, events, owner strike points and reach. Identity columns are null when `includeIdentity` is false. Backed by `moderation_queue`. */
  readQueue(options: ReadQueueOptions): Promise<QueueItem[]>

  // Roles

  /** The user's role, or null when `moderation_roles` has no row (treated as `member`). Backed by `moderation_roles`. */
  getRole(userId: string): Promise<Role | null>

  /** Roles and display names for many users; absent ids are omitted. Backed by `moderation_roles`. */
  listRoles(userIds: string[]): Promise<RoleRow[]>
}

// ---------------------------------------------------------------------------
// Notifier
// ---------------------------------------------------------------------------

/**
 * Side effects the host owns. The kit calls these after its own writes
 * succeed; a thrown error is logged by the caller and never rolls anything
 * back. Dedupe of repeated tier notices is the host's concern.
 */
export interface Notifier {
  /** A strike moved the member into a notified tier. Called once per upward tier change, never on the way down. */
  onTierEscalated(notice: {
    userId: string
    tier: StrikeTier
    messageKey: StockMessageKey
    issueType: IssueType | null
    strikeId: string | null
    eventId: string | null
  }): Promise<void>

  /** An appeal was upheld or overturned. */
  onAppealResolved(notice: {
    userId: string
    appealId: string
    resolution: AppealResolution
    messageKey: StockMessageKey
  }): Promise<void>

  /** Content became visible after review; `policy` is the reach-scaled fan-out the host may apply. */
  onContentApproved(notice: { contentId: string; ownerId: string; policy: NotificationPolicy }): Promise<void>
}

// ---------------------------------------------------------------------------
// ModerationProvider
// ---------------------------------------------------------------------------

/** A scorer for text. Never throws; every failure is an `unavailable` outcome. */
export interface ModerationProvider {
  /** Identifier written to `ai_flag` event details. */
  readonly name: string
  analyze(text: string, signal?: AbortSignal): Promise<ModerationOutcome>
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/** Milliseconds since the epoch. Strike expiry, debounce and trust age all read this. */
export interface Clock {
  now(): number
}

// ---------------------------------------------------------------------------
// Authorizer (server side)
// ---------------------------------------------------------------------------

/**
 * Resolves the caller of a server handler. Throws `ModerationError('unauthenticated')`
 * with no session and `ModerationError('forbidden')` below `minRole`.
 * The reference admin reads the session from the request and the role from
 * `moderation_roles`.
 */
export interface Authorizer {
  requireRole(minRole: Role): Promise<Principal>
}

// ---------------------------------------------------------------------------
// Dependency bundle
// ---------------------------------------------------------------------------

export interface PipelineDeps {
  store: ModerationStore
  provider: ModerationProvider
  notifier: Notifier
  clock: Clock
  config: ModerationConfig
}
