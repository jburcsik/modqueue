import { z } from 'zod'
import { defaultConfig, type ModerationConfig } from './config.js'
import { APPEAL_RESOLUTIONS, AUTOMATION_LEVELS, ISSUE_TYPES, MODERATION_OPS, SEVERITIES, TARGET_TYPES } from './types.js'

const REASON_MAX_CHARS = 2000
const KEYWORD_MAX_CHARS = 64
const KEYWORD_LIST_MAX = 100

/** Request schemas for the server handlers, with the length bounds taken from config. */
export function createSchemas(config: Pick<ModerationConfig, 'reports' | 'appeals'> = defaultConfig) {
  const { reports, appeals } = config

  const report = z.object({
    target_id: z.guid(),
    reason: z.string().max(reports.reasonMaxChars).nullable().optional(),
    evidence_paths: z.array(z.string().max(reports.evidencePathMaxChars).regex(reports.evidencePathPattern)).max(reports.maxEvidencePaths).default([]),
  })

  const appeal = z.object({
    strike_id: z.guid(),
    statement: z.string().min(appeals.statementMinChars).max(appeals.statementMaxChars),
  })

  const resolveAppeal = z.object({
    appeal_id: z.guid(),
    resolution: z.enum(APPEAL_RESOLUTIONS),
    reviewer_note: z.string().max(REASON_MAX_CHARS).nullable().optional(),
  })

  const moderationAction = z
    .object({
      target_id: z.guid(),
      target_type: z.enum(TARGET_TYPES),
      op: z.enum(MODERATION_OPS),
      reason: z.string().max(REASON_MAX_CHARS).nullable().optional(),
      strike_severity: z.enum(SEVERITIES).nullable().optional(),
      issue_type: z.enum(ISSUE_TYPES).nullable().optional(),
      case_id: z.guid().nullable().optional(),
    })
    .refine((value) => value.op !== 'note' || Boolean(value.reason?.trim()), { message: 'A note needs text', path: ['reason'] })
    .refine((value) => (value.op !== 'remove' && !value.strike_severity) || Boolean(value.reason?.trim()), {
      message: 'A reason is required to remove or to add a strike',
      path: ['reason'],
    })

  const claimCase = z.object({
    case_id: z.guid(),
    force: z.boolean().default(false),
  })

  const keywords = z.array(z.string().min(1).max(KEYWORD_MAX_CHARS)).max(KEYWORD_LIST_MAX)

  const settings = z
    .object({
      automationLevel: z.enum(AUTOMATION_LEVELS).optional(),
      warnThreshold: z.number().min(0).max(1).optional(),
      holdThreshold: z.number().min(0).max(1).optional(),
      autoActionConfidence: z.number().min(0).max(1).optional(),
      autoWarnKeywords: keywords.optional(),
      autoBlockKeywords: keywords.optional(),
      fullAutoAcknowledgedAt: z.iso.datetime({ offset: true }).nullable().optional(),
      autoHideWeight: z.number().positive().optional(),
      reportMinAccountAgeHours: z.number().int().min(0).optional(),
      reportRateMax: z.number().int().positive().optional(),
      reportRateWindowSeconds: z.number().int().positive().optional(),
      appealRateMax: z.number().int().positive().optional(),
      appealRateWindowSeconds: z.number().int().positive().optional(),
      reportIdentityRetentionDays: z.number().int().min(0).optional(),
      reachEnabled: z.boolean().optional(),
    })
    .refine((value) => value.automationLevel !== 'full_auto' || value.fullAutoAcknowledgedAt !== null, {
      message: 'full_auto needs an acknowledgement',
      path: ['fullAutoAcknowledgedAt'],
    })

  return { report, appeal, resolveAppeal, moderationAction, claimCase, settings }
}

export const schemas = createSchemas(defaultConfig)
export const reportSchema = schemas.report
export const appealSchema = schemas.appeal
export const resolveAppealSchema = schemas.resolveAppeal
export const moderationActionSchema = schemas.moderationAction
export const claimCaseSchema = schemas.claimCase
export const settingsSchema = schemas.settings

export type ReportInput = z.infer<typeof reportSchema>
export type AppealInput = z.infer<typeof appealSchema>
export type ResolveAppealInput = z.infer<typeof resolveAppealSchema>
export type ModerationActionRequest = z.infer<typeof moderationActionSchema>
export type ClaimCaseInput = z.infer<typeof claimCaseSchema>
export type SettingsPatch = z.infer<typeof settingsSchema>
