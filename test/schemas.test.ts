import { describe, expect, it } from 'vitest'
import { defaultConfig, mergeConfig } from '../src/config.js'
import { appealSchema, claimCaseSchema, createSchemas, moderationActionSchema, reportSchema, resolveAppealSchema, settingsSchema } from '../src/schemas.js'
import { USER_A, USER_B } from './helpers.js'

describe('reportSchema', () => {
  it('accepts a target with an optional reason and evidence paths', () => {
    const parsed = reportSchema.safeParse({ target_id: USER_A, reason: 'spam', evidence_paths: ['uploads/a1.jpg'] })
    expect(parsed.success).toBe(true)
    expect(reportSchema.parse({ target_id: USER_A }).evidence_paths).toEqual([])
  })

  it('rejects a bad id, too many paths, a malformed path and a long reason', () => {
    expect(reportSchema.safeParse({ target_id: 'nope' }).success).toBe(false)
    expect(reportSchema.safeParse({ target_id: USER_A, evidence_paths: ['a', 'b', 'c'] }).success).toBe(false)
    for (const path of ['../etc/passwd', 'evidence/../x', 'a//b', 'a/', '/a', './a']) {
      expect(reportSchema.safeParse({ target_id: USER_A, evidence_paths: [path] }).success, path).toBe(false)
    }
    expect(reportSchema.safeParse({ target_id: USER_A, evidence_paths: ['evidence/one.png', 'a.b/c-d_e'] }).success).toBe(true)
    expect(reportSchema.safeParse({ target_id: USER_A, reason: 'x'.repeat(defaultConfig.reports.reasonMaxChars + 1) }).success).toBe(false)
  })
})

describe('appealSchema', () => {
  it('bounds the statement length', () => {
    expect(appealSchema.safeParse({ strike_id: USER_A, statement: 'x'.repeat(defaultConfig.appeals.statementMinChars) }).success).toBe(true)
    expect(appealSchema.safeParse({ strike_id: USER_A, statement: 'x'.repeat(defaultConfig.appeals.statementMinChars - 1) }).success).toBe(false)
    expect(appealSchema.safeParse({ strike_id: USER_A, statement: 'x'.repeat(defaultConfig.appeals.statementMaxChars + 1) }).success).toBe(false)
  })
})

describe('resolveAppealSchema', () => {
  it('accepts the two resolutions and rejects others', () => {
    expect(resolveAppealSchema.safeParse({ appeal_id: USER_A, resolution: 'uphold' }).success).toBe(true)
    expect(resolveAppealSchema.safeParse({ appeal_id: USER_A, resolution: 'overturn', reviewer_note: null }).success).toBe(true)
    expect(resolveAppealSchema.safeParse({ appeal_id: USER_A, resolution: 'maybe' }).success).toBe(false)
  })
})

describe('moderationActionSchema', () => {
  it('accepts every op including hold', () => {
    for (const op of ['approve', 'hold', 'warn', 'dismiss']) {
      expect(moderationActionSchema.safeParse({ target_id: USER_A, target_type: 'content', op }).success).toBe(true)
    }
  })

  it('requires a reason for note, remove and a strike', () => {
    expect(moderationActionSchema.safeParse({ target_id: USER_A, target_type: 'content', op: 'note' }).success).toBe(false)
    expect(moderationActionSchema.safeParse({ target_id: USER_A, target_type: 'content', op: 'note', reason: '  ' }).success).toBe(false)
    expect(moderationActionSchema.safeParse({ target_id: USER_A, target_type: 'content', op: 'remove' }).success).toBe(false)
    expect(moderationActionSchema.safeParse({ target_id: USER_A, target_type: 'content', op: 'warn', strike_severity: 'info' }).success).toBe(false)
    expect(moderationActionSchema.safeParse({ target_id: USER_A, target_type: 'content', op: 'remove', reason: 'spam', case_id: USER_B }).success).toBe(true)
  })

  it('rejects unknown ops, targets and issue types', () => {
    expect(moderationActionSchema.safeParse({ target_id: USER_A, target_type: 'content', op: 'ban' }).success).toBe(false)
    expect(moderationActionSchema.safeParse({ target_id: USER_A, target_type: 'post', op: 'approve' }).success).toBe(false)
    expect(moderationActionSchema.safeParse({ target_id: USER_A, target_type: 'content', op: 'warn', issue_type: 'vibes' }).success).toBe(false)
  })
})

describe('claimCaseSchema', () => {
  it('defaults force to false', () => {
    expect(claimCaseSchema.parse({ case_id: USER_A })).toEqual({ case_id: USER_A, force: false })
    expect(claimCaseSchema.safeParse({ case_id: 'x' }).success).toBe(false)
  })
})

describe('settingsSchema', () => {
  it('accepts a partial patch within bounds', () => {
    expect(settingsSchema.safeParse({ warnThreshold: 0.4, autoWarnKeywords: ['spam'], reachEnabled: false }).success).toBe(true)
    expect(settingsSchema.safeParse({}).success).toBe(true)
  })

  it('rejects out-of-range thresholds and bad levels', () => {
    expect(settingsSchema.safeParse({ holdThreshold: 1.5 }).success).toBe(false)
    expect(settingsSchema.safeParse({ automationLevel: 'manual' }).success).toBe(false)
    expect(settingsSchema.safeParse({ reportRateMax: 0 }).success).toBe(false)
  })

  it('refuses full_auto with a null acknowledgement and accepts it with one', () => {
    expect(settingsSchema.safeParse({ automationLevel: 'full_auto', fullAutoAcknowledgedAt: null }).success).toBe(false)
    expect(settingsSchema.safeParse({ automationLevel: 'full_auto', fullAutoAcknowledgedAt: '2030-01-01T00:00:00Z' }).success).toBe(true)
    expect(settingsSchema.safeParse({ fullAutoAcknowledgedAt: 'yesterday' }).success).toBe(false)
  })
})

describe('createSchemas', () => {
  it('reads its bounds from the config it is given', () => {
    const tight = createSchemas(mergeConfig(defaultConfig, { appeals: { statementMinChars: 1, statementMaxChars: 5 } }))
    expect(tight.appeal.safeParse({ strike_id: USER_A, statement: 'ok' }).success).toBe(true)
    expect(tight.appeal.safeParse({ strike_id: USER_A, statement: 'too long' }).success).toBe(false)
  })
})
