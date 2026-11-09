// Shared types for modqueue.
//
// Every enumerated value is declared once as an `as const` array. The SQL CHECK
// lists in supabase/migrations/0001_modqueue.sql carry the same values in the
// same order; test/sql-parity.test.ts compares the two so they cannot drift.

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export const ROLES = ['member', 'moderator', 'admin'] as const
export type Role = (typeof ROLES)[number]

export const CONTENT_STATES = ['visible', 'held', 'removed'] as const
export type ContentState = (typeof CONTENT_STATES)[number]

export const CASE_STATES = ['open', 'claimed', 'decided', 'reversed'] as const
export type CaseState = (typeof CASE_STATES)[number]

export const CASE_DECISIONS = ['keep', 'remove', 'restore'] as const
export type CaseDecision = (typeof CASE_DECISIONS)[number]

export const REPORT_STATES = ['open', 'upheld', 'rejected', 'duplicate', 'withdrawn'] as const
export type ReportState = (typeof REPORT_STATES)[number]

export const APPEAL_STATES = ['pending', 'upheld', 'overturned'] as const
export type AppealState = (typeof APPEAL_STATES)[number]

export const APPEAL_RESOLUTIONS = ['uphold', 'overturn'] as const
export type AppealResolution = (typeof APPEAL_RESOLUTIONS)[number]

export const SEVERITIES = ['info', 'warning', 'violation', 'severe'] as const
export type Severity = (typeof SEVERITIES)[number]

export const STRIKE_TIERS = ['clean', 'nudge', 'warned', 'review_gated', 'quieted'] as const
export type StrikeTier = (typeof STRIKE_TIERS)[number]

export const MODERATION_OPS = ['approve', 'hold', 'warn', 'remove', 'dismiss', 'note'] as const
export type ModerationOp = (typeof MODERATION_OPS)[number]

export const AUTOMATION_LEVELS = ['off', 'assist', 'semi_auto', 'full_auto'] as const
export type AutomationLevel = (typeof AUTOMATION_LEVELS)[number]

export const DECISION_TIERS = ['allow', 'allow_log', 'warn', 'hold'] as const
export type DecisionTier = (typeof DECISION_TIERS)[number]

export const ACTOR_SOURCES = ['member', 'moderator', 'admin', 'automated', 'provider', 'system'] as const
export type ActorSource = (typeof ACTOR_SOURCES)[number]

/** Sources that may perform a moderation action through the action spine. */
export type ActionActor = Exclude<ActorSource, 'member' | 'provider'>

export const EVENT_TYPES = [
  'content_hold',
  'content_remove',
  'content_restore',
  'content_approve',
  'content_warn',
  'mod_note',
  'strike_added',
  'strike_revoked',
  'tier_hold',
  'ai_flag',
  'auto_allow',
  'escalated',
  'user_lookup',
  'appeal_filed',
  'appeal_resolved',
  'tripwire',
] as const
export type EventType = (typeof EVENT_TYPES)[number]

export const TARGET_TYPES = ['content', 'user'] as const
export type TargetType = (typeof TARGET_TYPES)[number]

export const TRUST_LEVELS = ['new', 'restricted', 'limited', 'full'] as const
export type TrustLevel = (typeof TRUST_LEVELS)[number]

export const ISSUE_TYPES = ['accuracy', 'tone', 'off_topic', 'privacy', 'duplicate'] as const
export type IssueType = (typeof ISSUE_TYPES)[number]

export const STOCK_MESSAGE_KEYS = ['warning', 'review_gated', 'quieted', 'appeal_upheld', 'appeal_overturned'] as const
export type StockMessageKey = (typeof STOCK_MESSAGE_KEYS)[number]

export const QUEUE_FILTERS = ['open', 'claimed', 'mine', 'decided'] as const
export type QueueFilter = (typeof QUEUE_FILTERS)[number]

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const ERROR_CODES = [
  'unauthenticated',
  'forbidden',
  'not_found',
  'invalid_input',
  'rate_limited',
  'account_too_new',
  'self_report',
  'duplicate_report',
  'duplicate_appeal',
  'not_strike_owner',
  'strike_inactive',
  'appeal_not_pending',
  'case_not_open',
  'case_claimed_by_other',
  'posting_paused',
  'content_blocked',
  'store_error',
] as const
export type ModerationErrorCode = (typeof ERROR_CODES)[number]

/** HTTP status the reference admin returns for each code. */
export const ERROR_HTTP_STATUS: Record<ModerationErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid_input: 400,
  rate_limited: 429,
  account_too_new: 403,
  self_report: 400,
  duplicate_report: 409,
  duplicate_appeal: 409,
  not_strike_owner: 403,
  strike_inactive: 409,
  appeal_not_pending: 409,
  case_not_open: 409,
  case_claimed_by_other: 409,
  posting_paused: 403,
  content_blocked: 422,
  store_error: 500,
}

/**
 * The only error class the kit throws. `code` is stable and is what callers
 * branch on; `message` is for logs and never shown to a member verbatim.
 */
export class ModerationError extends Error {
  readonly code: ModerationErrorCode
  readonly detail: string | null

  constructor(code: ModerationErrorCode, detail?: string, options?: { cause?: unknown }) {
    super(detail ? `${code}: ${detail}` : code, options)
    this.name = 'ModerationError'
    this.code = code
    this.detail = detail ?? null
  }

  static is(value: unknown): value is ModerationError {
    return value instanceof ModerationError
  }
}

// ---------------------------------------------------------------------------
// Settings (the single admin-editable row in moderation_settings)
// ---------------------------------------------------------------------------

/**
 * Runtime tunables that both the TypeScript pipeline and the SQL functions
 * read. Column names are the snake_case form of these fields. Column defaults
 * in the migration equal `defaultConfig.settings`.
 */
export interface Settings {
  automationLevel: AutomationLevel
  /** Max category score at or above which a submission is warned. */
  warnThreshold: number
  /** Max category score at or above which a submission is held. */
  holdThreshold: number
  /** Confidence floor below which automated actions become shadow logs. */
  autoActionConfidence: number
  autoWarnKeywords: string[]
  autoBlockKeywords: string[]
  /** Must be set before `automationLevel` may be `full_auto` (CHECK in SQL). */
  fullAutoAcknowledgedAt: string | null
  /** Sum of open reports' trust weight at or above which content is auto-held. */
  autoHideWeight: number
  /** Account age below which `file_report` refuses with `account_too_new`. */
  reportMinAccountAgeHours: number
  reportRateMax: number
  reportRateWindowSeconds: number
  appealRateMax: number
  appealRateWindowSeconds: number
  /** Days after resolution before `purge_report_identities` nulls reporter_id. */
  reportIdentityRetentionDays: number
  /** When false, SQL reach returns 1.0 and reports carry trust weight 1.0. */
  reachEnabled: boolean
  updatedAt: string | null
  updatedBy: string | null
}

// ---------------------------------------------------------------------------
// Trust, reputation, reach
// ---------------------------------------------------------------------------

export interface TrustInfo {
  level: TrustLevel
  accountAgeHours: number
  /** May file reports against other members' content. */
  canReport: boolean
  /** Daily submission cap, enforced through the rate limiter with a one-day window. */
  submissionsPerDay: number
  /** New submissions start `held` and open a case. */
  requiresApproval: boolean
}

/** One row of the host-defined view `moderation_reputation_inputs`. */
export interface ReputationInputs {
  user_id: string
  account_created_at: string
  posts: number
  endorsed_posts: number
  endorsements_given: number
  reports_received: number
  /** Share of recent submissions the host judged far from their origin; null when unknown or not tracked. */
  far_rate: number | null
}

export interface ReachInputs {
  reputation: ReputationInputs | null
  activeStrikePoints: number
  nowMs: number
}

export interface ReachFactors {
  age: number
  reputation: number
  strikes: number
  engagement: number
  farReport: number
}

export interface ReachResult {
  /** Product of the five factors, clamped to `config.reach.clamp`. 1.0 when `enabled` is false. */
  coefficient: number
  enabled: boolean
  /** True when the SQL function failed; coefficient is then 1.0 and factors are all 1.0. */
  error: boolean
  factors: ReachFactors
  inputs: {
    accountAgeHours: number
    reputationScore: number
    activeStrikePoints: number
    posts: number
    endorsedPosts: number
    endorsementsGiven: number
    reportsReceived: number
    farRate: number | null
  }
}

export interface NotificationPolicy {
  shouldNotify: boolean
  radiusMultiplier: number
}

// ---------------------------------------------------------------------------
// Scoring and automation
// ---------------------------------------------------------------------------

export interface ProviderResult {
  flagged: boolean
  categories: Record<string, boolean>
  scores: Record<string, number>
}

export const PROVIDER_UNAVAILABLE_REASONS = ['not_configured', 'api_error', 'invalid_response', 'network_error', 'timeout'] as const
export type ProviderUnavailableReason = (typeof PROVIDER_UNAVAILABLE_REASONS)[number]

/**
 * What a provider call produced. `unavailable` is never read as a verdict:
 * the text path treats it as allow with confidence 0 and sets
 * `ModerationDecision.providerUnavailable`; a host screening binary media
 * must fail closed on it.
 */
export type ModerationOutcome =
  | { status: 'screened'; result: ProviderResult }
  | { status: 'unavailable'; reason: ProviderUnavailableReason; detail: string | null }

export interface ModerationDecision {
  tier: DecisionTier
  severity: Severity | null
  flaggedCategories: string[]
  scores: Record<string, number>
  /** Highest category score, 0 to 1. 0 when the provider was unavailable. */
  confidence: number
  reason: string | null
  providerUnavailable: boolean
}

export interface AutomatedActionResult {
  /** True when content state changed or a strike was added. */
  acted: boolean
  op: ModerationOp | null
  /** Event written for a shadow log, auto allow or escalation; null when `acted`. */
  logged: EventType | null
  eventId: string | null
}

// ---------------------------------------------------------------------------
// Strikes and the consequence ladder
// ---------------------------------------------------------------------------

export interface StrikeWeight {
  points: number
  /** Null means the strike never expires. */
  decayDays: number | null
}

export interface StrikeConsequence {
  tier: StrikeTier
  points: number
  /** True for tiers that send a notification on entry. Lower tiers are silent. */
  notify: boolean
  messageKey: StockMessageKey | null
  canPost: boolean
  requiresApproval: boolean
}

export interface StrikeInput {
  userId: string
  severity: Severity
  points: number
  reason: string
  expiresAt: string | null
  moderationEventId: string | null
}

export interface StrikeRow {
  id: string
  userId: string
  severity: Severity
  points: number
  reason: string
  moderationEventId: string | null
  expiresAt: string | null
  revokedAt: string | null
  revokedBy: string | null
  createdAt: string
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface ModerationEventInput {
  targetType: TargetType
  targetId: string
  eventType: EventType
  source: ActorSource
  severity: Severity
  /** Moderator-facing sentence; may name the actor. Never shown to members. */
  summary: string | null
  details: Record<string, unknown>
  actorId: string | null
  caseId: string | null
  /** Content state before a content_* event; null otherwise. */
  priorState: ContentState | null
}

/** An event the pipeline will write once the content row exists. */
export type PendingEvent = Omit<ModerationEventInput, 'targetType' | 'targetId'>

export interface EventRow extends ModerationEventInput {
  id: string
  createdAt: string
}

// ---------------------------------------------------------------------------
// Actions (the spine)
// ---------------------------------------------------------------------------

export interface ModerationActionInput {
  targetType: TargetType
  targetId: string
  op: ModerationOp
  actor: ActionActor
  /** Acting human; null for automated and system. */
  actorId: string | null
  /** Display name for the audit summary; null falls back to a role label. */
  actorName: string | null
  reason: string | null
  /** Automated confidence 0 to 1; null for humans. */
  confidence: number | null
  strike: { severity: Severity; reason: string } | null
  /** Owner of the content; equals targetId for user targets. Required when `strike` is set. */
  ownerId: string | null
  issueType: IssueType | null
  /** The open case the caller is settling; null for user targets and for holds with no case yet. */
  caseId: string | null
}

export interface ModerationActionResult {
  eventId: string | null
  strikeId: string | null
  /** Set when the op settled a case through `decide_moderation_case`. */
  decision: DecideCaseResult | null
  consequenceBefore: StrikeConsequence | null
  consequenceAfter: StrikeConsequence | null
}

export interface DecideCaseInput {
  caseId: string
  decision: CaseDecision
  /** null for approve, false for dismiss, true for remove. Resolves open reports to upheld or rejected. */
  flagJustified: boolean | null
  actorId: string | null
  source: ActorSource
  /** Written as the audit row's summary. */
  reason: string | null
}

export interface DecideCaseResult {
  caseId: string
  decision: CaseDecision
  moderationState: ContentState
  priorState: ContentState
  reportsResolved: number
  eventId: string
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** The content contract: the columns `public.moderation_content` must expose. */
export interface ContentRow {
  id: string
  ownerId: string
  moderationState: ContentState
  createdAt: string
  body: string | null
}

export interface CaseRow {
  id: string
  targetId: string
  state: CaseState
  claimedBy: string | null
  claimedAt: string | null
  decidedAt: string | null
  decision: CaseDecision | null
  createdAt: string
}

export interface ReportRow {
  id: string
  caseId: string | null
  targetId: string
  /** Null after the identity purge, or when shaped for a moderator. */
  reporterId: string | null
  reason: string | null
  evidencePaths: string[]
  trustWeight: number
  state: ReportState
  createdAt: string
  resolvedAt: string | null
}

export interface FileReportInput {
  reporterId: string
  targetId: string
  reason: string | null
  evidencePaths: string[]
}

export interface AppealRow {
  id: string
  userId: string
  strikeId: string
  moderationEventId: string | null
  statement: string
  state: AppealState
  resolvedBy: string | null
  resolvedAt: string | null
  reviewerNote: string | null
  createdAt: string
}

export interface FileAppealInput {
  userId: string
  strikeId: string
  statement: string
}

export interface RoleRow {
  userId: string
  role: Role
  displayName: string | null
}

export interface Principal {
  userId: string
  role: Role
  displayName: string | null
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export interface ReadQueueOptions {
  filter: QueueFilter
  /** Caller, used by the `mine` filter. */
  callerId: string
  /** Restrict to one owner; admins only. */
  ownerId: string | null
  /** False strips owner and reporter identity from every item. */
  includeIdentity: boolean
  limit: number
}

export interface QueueItem {
  caseId: string
  caseState: CaseState
  claimedBy: string | null
  claimedAt: string | null
  caseCreatedAt: string
  contentId: string
  ownerId: string | null
  ownerDisplayName: string | null
  moderationState: ContentState
  contentCreatedAt: string
  preview: string | null
  openReportCount: number
  totalReportCount: number
  reports: ReportRow[]
  events: EventRow[]
  ownerStrikePoints: number
  ownerReach: ReachResult | null
  /** 1 held, 2 two or more open reports, 3 otherwise. Sorted ascending, then oldest first. */
  priority: 1 | 2 | 3
}

// ---------------------------------------------------------------------------
// Content filter
// ---------------------------------------------------------------------------

export interface NormalizeResult {
  clean: string
  strippedCount: number
  suspicious: boolean
}

export interface TripwireResult {
  hit: boolean
  patterns: string[]
}

export interface FilterResult {
  /** Normalized text; the only form stored or sent to a provider. */
  clean: string
  blocked: boolean
  reason: string | null
  warnings: string[]
  piiFound: string[]
  normalizer: NormalizeResult
  tripwire: TripwireResult
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface ScreenSubmissionInput {
  text: string
  userId: string
  accountCreatedAt: string
  /** Null when the host has no reputation view; reach then uses the neutral inputs. */
  reputationInputs: ReputationInputs | null
  /** Moderators and admins skip trust and ladder gating. */
  role: Role
  /** Base lifetime for reach-scaled expiry; null when the host has no expiry. */
  baseTtlHours: number | null
}

export interface ScreenSubmissionResult {
  /** False when the host must refuse the submission; `rejection` says why. */
  allowed: boolean
  rejection: ModerationErrorCode | null
  /** The submitting member; `recordSubmission` strikes and logs against it. */
  userId: string
  clean: string
  filter: FilterResult
  trust: TrustInfo
  decision: ModerationDecision | null
  consequence: StrikeConsequence
  reach: ReachResult
  ttlHours: number | null
  /** `held` when the decision tier is hold, or trust or ladder requires approval; else `visible`. */
  initialState: ContentState
  /** Events to write against the content row once it exists; see `recordSubmission`. */
  events: PendingEvent[]
}

export interface StockMessage {
  title: string
  body: string
}
