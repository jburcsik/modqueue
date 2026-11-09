// ModerationConfig and its defaults.
//
// Every number here is a tunable. The defaults are illustrative and are not
// the values any live deployment runs; a host tunes them before launch.
// Structural constants (clamps, provider category names) are not tunables and
// are marked as such.

import type { Severity, Settings, StrikeWeight, TrustLevel } from './types.js'

// ---------------------------------------------------------------------------
// Step tables
// ---------------------------------------------------------------------------

/** One row of a step table: applies when the input is strictly below `below`. */
export interface Step {
  below: number
  value: number
}

/**
 * A piecewise lookup. Rows are checked in order; the first row whose `below`
 * exceeds the input wins; `otherwise` applies when none does. Rows must be
 * sorted by `below` ascending.
 */
export interface StepTable {
  steps: ReadonlyArray<Step>
  otherwise: number
}

export interface NotificationStep {
  below: number
  shouldNotify: boolean
  radiusMultiplier: number
}

// ---------------------------------------------------------------------------
// Config sections
// ---------------------------------------------------------------------------

export interface TrustTier {
  level: TrustLevel
  /** Upper bound in hours, exclusive. Null marks the final tier. */
  maxAgeHours: number | null
  canReport: boolean
  submissionsPerDay: number
  requiresApproval: boolean
}

export interface TrustConfig {
  /** Sorted by `maxAgeHours` ascending; the last entry has `maxAgeHours: null`. */
  tiers: ReadonlyArray<TrustTier>
  /** Reputation score at or above which the daily cap is multiplied and approval is lifted (except for the first tier). */
  boostAt: number
  boostMultiplier: number
  boostCap: number
  /** Reputation score at or below which the daily cap is divided and approval is forced. */
  restrictAt: number
  restrictDivisor: number
  restrictFloor: number
}

export interface ReputationConfig {
  baseline: number
  endorsedPostWeight: number
  endorsedPostCap: number
  endorsementGivenWeight: number
  endorsementGivenCap: number
  postWeight: number
  postCap: number
  reportReceivedWeight: number
  reportReceivedCap: number
  /** Structural: the score range. */
  min: number
  max: number
}

export interface EngagementConfig {
  /** With no reports received, this many endorsed posts or more earns `bonusFactor`. */
  bonusMinEndorsedPosts: number
  bonusFactor: number
  /** endorsed_posts divided by reports_received above this ratio is neutral (1.0); below it is `penaltyFactor`. */
  neutralRatio: number
  penaltyFactor: number
}

export interface ReachConfig {
  /** When false, `computeReach` returns coefficient 1.0 with every factor 1.0. */
  enabled: boolean
  /** Structural: coefficient bounds. */
  clamp: { min: number; max: number }
  /** Coefficient when the reputation view has no row for the user. */
  unknownUserCoefficient: number
  /** Input: account age in hours. */
  age: StepTable
  /** Input: reputation score. */
  reputation: StepTable
  /** Input: active strike points. */
  strikes: StepTable
  engagement: EngagementConfig
  /** Input: far_rate. Null far_rate is factor 1.0. */
  farReport: StepTable
  /** Content lifetime multiplier bounds applied by `applyReachToTtl`. */
  ttl: { floorMultiplier: number; ceilingMultiplier: number }
  /** Input: coefficient. Sorted ascending; `radiusCap` bounds the multiplier above the last step. */
  notification: { steps: ReadonlyArray<NotificationStep>; radiusCap: number }
  /** Below this coefficient content is visible only to its owner. Enforced by the host's read path. */
  visibilityFloor: number
}

export interface LadderConfig {
  /** Active points at which each tier begins. `clean` is below `nudge`. */
  nudge: number
  warned: number
  reviewGated: number
  quieted: number
}

export interface StrikesConfig {
  weights: Record<Severity, StrikeWeight>
  ladder: LadderConfig
  /** Structural: the CHECK range on user_strikes.points. */
  pointsMin: number
  pointsMax: number
}

export interface ScoringConfig {
  /** Structural: provider category names that hold regardless of thresholds. */
  severeCategories: ReadonlyArray<string>
  /** Score strictly above which a severe category holds. */
  severeScoreFloor: number
  /** Max score at or above which an allow is logged as `allow_log`. */
  allowLogFloor: number
}

export interface AutomationConfig {
  /** `full_auto` removes a hold-tier submission only at or above max(this, settings.autoActionConfidence). */
  fullAutoRemoveFloor: number
  /** Label shown for the `automated` actor in audit summaries and the reference admin. */
  automatedActorLabel: string
}

export interface RateLimitPreset {
  windowSeconds: number
  max: number
}

export interface RateLimitsConfig {
  /** Content writes per user. */
  submit: RateLimitPreset
  /** Queue and log reads per user. */
  read: RateLimitPreset
  /** Reports per user. Must equal settings.reportRateMax and settings.reportRateWindowSeconds. */
  report: RateLimitPreset
  /** Appeals per user. Must equal settings.appealRateMax and settings.appealRateWindowSeconds. */
  appeal: RateLimitPreset
  signupHourly: RateLimitPreset
  signupDaily: RateLimitPreset
  /** When true every check returns allowed. Off by default; set explicitly, never from the environment. */
  bypass: boolean
}

export interface PiiPattern {
  name: string
  pattern: RegExp
}

export interface FilterConfig {
  /** Lowercase substrings that block a submission. Empty by default. */
  blockedTerms: ReadonlyArray<string>
  /** Patterns that block with a coaching message. Empty by default. */
  profilingPhrases: ReadonlyArray<RegExp>
  blockedTermsMessage: string
  profilingMessage: string
  /** Patterns that warn without blocking. */
  piiPatterns: ReadonlyArray<PiiPattern>
  /** Cleaned text shorter than this adds a warning. */
  minLengthChars: number
}

export interface TripwirePattern {
  name: string
  pattern: RegExp
}

export interface TripwireConfig {
  /** Detect only; a hit writes a `tripwire` event and never blocks. */
  patterns: ReadonlyArray<TripwirePattern>
}

export interface ReportsConfig {
  reasonMaxChars: number
  maxEvidencePaths: number
  /** Opaque storage keys; the kit signs nothing. The SQL guard matches the same shape. */
  evidencePathPattern: RegExp
  evidencePathMaxChars: number
}

export interface AppealsConfig {
  /** The CHECK on moderation_appeals.statement uses the same bounds. */
  statementMinChars: number
  statementMaxChars: number
}

export interface MessagesConfig {
  /** Inserted into stock copy when set; copy reads "this community" otherwise. */
  brandName?: string
}

export interface ModerationConfig {
  trust: TrustConfig
  reputation: ReputationConfig
  reach: ReachConfig
  strikes: StrikesConfig
  scoring: ScoringConfig
  automation: AutomationConfig
  rateLimits: RateLimitsConfig
  filter: FilterConfig
  tripwire: TripwireConfig
  reports: ReportsConfig
  appeals: AppealsConfig
  messages: MessagesConfig
  /** Identical user_lookup events by the same actor within this window are not written again. */
  userLookupDebounceMs: number
  /** Defaults for the moderation_settings row; the migration's column defaults equal these. */
  settings: Settings
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const HOUR = 60 * 60
const DAY = 24 * HOUR

export const defaultConfig: ModerationConfig = {
  trust: {
    tiers: [
      { level: 'new', maxAgeHours: 48, canReport: false, submissionsPerDay: 2, requiresApproval: true },
      { level: 'restricted', maxAgeHours: 7 * 24, canReport: true, submissionsPerDay: 4, requiresApproval: true },
      { level: 'limited', maxAgeHours: 14 * 24, canReport: true, submissionsPerDay: 8, requiresApproval: false },
      { level: 'full', maxAgeHours: null, canReport: true, submissionsPerDay: 16, requiresApproval: false },
    ],
    boostAt: 70,
    boostMultiplier: 2,
    boostCap: 30,
    restrictAt: 30,
    restrictDivisor: 2,
    restrictFloor: 2,
  },

  reputation: {
    baseline: 40,
    endorsedPostWeight: 3,
    endorsedPostCap: 24,
    endorsementGivenWeight: 0.5,
    endorsementGivenCap: 10,
    postWeight: 1,
    postCap: 12,
    reportReceivedWeight: 4,
    reportReceivedCap: 32,
    min: 0,
    max: 100,
  },

  reach: {
    enabled: true,
    clamp: { min: 0, max: 1.5 },
    unknownUserCoefficient: 0.5,
    age: {
      steps: [
        { below: 48, value: 0.5 },
        { below: 7 * 24, value: 0.75 },
        { below: 14 * 24, value: 0.9 },
      ],
      otherwise: 1.0,
    },
    reputation: {
      steps: [
        { below: 25, value: 0.4 },
        { below: 40, value: 0.6 },
        { below: 55, value: 0.8 },
        { below: 70, value: 1.0 },
        { below: 85, value: 1.1 },
      ],
      otherwise: 1.15,
    },
    strikes: {
      steps: [
        { below: 1, value: 1.0 },
        { below: 4, value: 0.75 },
        { below: 6, value: 0.45 },
        { below: 8, value: 0.15 },
      ],
      otherwise: 0.1,
    },
    engagement: {
      bonusMinEndorsedPosts: 8,
      bonusFactor: 1.1,
      neutralRatio: 2,
      penaltyFactor: 0.85,
    },
    farReport: {
      steps: [
        { below: 0.25, value: 1.0 },
        { below: 0.5, value: 0.4 },
      ],
      otherwise: 0.1,
    },
    ttl: { floorMultiplier: 0.3, ceilingMultiplier: 1.4 },
    notification: {
      steps: [
        { below: 0.15, shouldNotify: false, radiusMultiplier: 0 },
        { below: 0.35, shouldNotify: true, radiusMultiplier: 0.3 },
        { below: 0.65, shouldNotify: true, radiusMultiplier: 0.6 },
        { below: 1.05, shouldNotify: true, radiusMultiplier: 1.0 },
      ],
      radiusCap: 1.25,
    },
    visibilityFloor: 0.15,
  },

  strikes: {
    weights: {
      info: { points: 1, decayDays: 60 },
      warning: { points: 2, decayDays: 60 },
      violation: { points: 3, decayDays: 60 },
      severe: { points: 5, decayDays: null },
    },
    ladder: { nudge: 2, warned: 4, reviewGated: 6, quieted: 8 },
    pointsMin: 1,
    pointsMax: 5,
  },

  scoring: {
    severeCategories: ['sexual/minors', 'self-harm/intent', 'violence/graphic'],
    severeScoreFloor: 0.4,
    allowLogFloor: 0.2,
  },

  automation: {
    fullAutoRemoveFloor: 0.95,
    automatedActorLabel: 'Automated review',
  },

  rateLimits: {
    submit: { windowSeconds: 60, max: 6 },
    read: { windowSeconds: 60, max: 60 },
    report: { windowSeconds: HOUR, max: 5 },
    appeal: { windowSeconds: DAY, max: 3 },
    signupHourly: { windowSeconds: HOUR, max: 5 },
    signupDaily: { windowSeconds: DAY, max: 20 },
    bypass: false,
  },

  filter: {
    blockedTerms: [],
    profilingPhrases: [],
    blockedTermsMessage: 'This text contains language that is not allowed here.',
    profilingMessage: 'Describe what the person is doing rather than how they look.',
    piiPatterns: [
      { name: 'phone', pattern: /\b(\+?1[-.\s]?)?(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})\b/g },
      { name: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
      { name: 'id_number', pattern: /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g },
      { name: 'licence_plate', pattern: /\b[A-Z]{2,4}[-\s]?\d{2,4}[-\s]?[A-Z]{0,3}\b/g },
    ],
    minLengthChars: 12,
  },

  tripwire: {
    patterns: [
      // Direct instruction override
      { name: 'ignore_instructions', pattern: /\bignore\s+(all\s+)?(previous|prior|above)\s+instructions?\b/i },
      { name: 'ignore_instructions', pattern: /\bignorez?\s+(?:(?:toutes?\s+)?les?\s+)?instructions?\s+pr\u00e9c\u00e9dentes?\b/i },
      { name: 'disregard_above', pattern: /\bdisregard\s+(the\s+)?(above|previous|prior)\b/i },
      { name: 'disregard_above', pattern: /\bne\s+(tiens|tenez)\s+pas\s+compte\s+(de\s+)?(ce\s+qui\s+pr\u00e9c\u00e8de|des\s+instructions)\b/i },
      { name: 'forget_instructions', pattern: /\bforget\s+(all\s+)?(previous|prior|your)\s+instructions?\b/i },
      { name: 'forget_instructions', pattern: /\boublie[sz]?\s+(toutes?\s+)?(les|tes|vos)\s+instructions?\b/i },
      { name: 'override_system', pattern: /\boverride\s+(your\s+)?(system|previous)?\s*instructions?\b/i },
      { name: 'new_instructions', pattern: /\bnew\s+instructions?\s*:/i },
      { name: 'new_instructions', pattern: /\bnouvelles?\s+instructions?\s*:/i },

      // Persona hijack
      { name: 'you_are_now', pattern: /\byou\s+are\s+now\s+(a|an|the)\b/i },
      { name: 'act_as', pattern: /\bact\s+as\s+(a|an|the|if)\b/i },
      { name: 'act_as', pattern: /\b(agis|agissez|comporte-toi)\s+comme\s+(un|une|si)\b/i },
      { name: 'pretend_to_be', pattern: /\bpretend\s+to\s+be\b/i },
      { name: 'pretend_to_be', pattern: /\bfai(s|tes)\s+semblant\s+d'\u00eatre\b/i },
      { name: 'developer_mode', pattern: /\bdeveloper\s+mode\b/i },
      { name: 'no_restrictions', pattern: /\bwithout\s+(any\s+)?restrictions?\b/i },
      { name: 'no_restrictions', pattern: /\bsans\s+(aucune\s+)?restrictions?\b/i },

      // Delimiter and prompt-leak attacks
      { name: 'system_tag', pattern: /<\/?\s*system\s*>/i },
      { name: 'chat_markup', pattern: /\[INST\]|\[\/INST\]|<\|im_start\|>|<\|im_end\|>/i },
      { name: 'end_of_prompt', pattern: /---+\s*(end|stop|system|assistant|user)\b/i },

      // Goal hijack and prompt extraction
      { name: 'instead_of', pattern: /\binstead\s+of\s+(classif|analy[sz]|evaluat|review)/i },
      { name: 'your_real_task', pattern: /\byour\s+(real|actual|true)\s+task\b/i },
      { name: 'print_prompt', pattern: /\bprint\s+(your\s+)?(system\s+)?prompt\b/i },
      { name: 'print_prompt', pattern: /\baffiche[sz]?\s+(ton|votre)\s+(prompt|instructions?)\b/i },
      { name: 'reveal_prompt', pattern: /\breveal\s+(your\s+)?(system\s+)?prompt\b/i },
      { name: 'reveal_prompt', pattern: /\br\u00e9v\u00e8le[sz]?\s+(ton|votre)\s+(prompt|instructions?)\b/i },
      { name: 'what_are_your_instructions', pattern: /\bwhat\s+are\s+your\s+instructions\b/i },
    ],
  },

  reports: {
    reasonMaxChars: 500,
    maxEvidencePaths: 2,
    evidencePathPattern: /^(?!(?:.*\/)?\.\.?(?:\/|$))[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)*$/,
    evidencePathMaxChars: 255,
  },

  appeals: {
    statementMinChars: 10,
    statementMaxChars: 1000,
  },

  messages: {},

  userLookupDebounceMs: 30 * 60 * 1000,

  settings: {
    automationLevel: 'assist',
    warnThreshold: 0.5,
    holdThreshold: 0.8,
    autoActionConfidence: 0.75,
    autoWarnKeywords: [],
    autoBlockKeywords: [],
    fullAutoAcknowledgedAt: null,
    autoHideWeight: 3.5,
    reportMinAccountAgeHours: 48,
    reportRateMax: 5,
    reportRateWindowSeconds: HOUR,
    appealRateMax: 3,
    appealRateWindowSeconds: DAY,
    reportIdentityRetentionDays: 60,
    reachEnabled: true,
    updatedAt: null,
    updatedBy: null,
  },
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends ReadonlyArray<unknown>
    ? T[K]
    : T[K] extends RegExp
      ? T[K]
      : T[K] extends object
        ? DeepPartial<T[K]>
        : T[K]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
}

function mergeObjects(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const current = out[key]
    out[key] = isPlainObject(current) && isPlainObject(value) ? mergeObjects(current, value) : value
  }
  return out
}

/** Deep-merges `partial` over `base`. Plain objects merge; arrays, patterns and scalars replace. */
export function mergeConfig(base: ModerationConfig, partial: DeepPartial<ModerationConfig>): ModerationConfig {
  return mergeObjects(
    base as unknown as Record<string, unknown>,
    partial as unknown as Record<string, unknown>,
  ) as unknown as ModerationConfig
}
