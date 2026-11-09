import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ACTOR_SOURCES,
  APPEAL_STATES,
  AUTOMATION_LEVELS,
  CASE_DECISIONS,
  CASE_STATES,
  CONTENT_STATES,
  EVENT_TYPES,
  REPORT_STATES,
  ROLES,
  SEVERITIES,
  TARGET_TYPES,
} from '../src/types.js'

const MIGRATION = resolve(import.meta.dirname, '../supabase/migrations/0001_modqueue.sql')

/**
 * Every one-line `check (col in ('a', 'b'))` list in the migration, keyed by
 * `table.column`, and the `as const` array it must equal in value and order.
 * A CHECK list without a row here fails the test.
 */
const CHECK_LISTS: Record<string, ReadonlyArray<string>> = {
  'moderation_roles.role': ROLES,
  'moderation_content.moderation_state': CONTENT_STATES,
  'moderation_settings.automation_level': AUTOMATION_LEVELS,
  'moderation_cases.state': CASE_STATES,
  'moderation_cases.decision': CASE_DECISIONS,
  'moderation_events.target_type': TARGET_TYPES,
  'moderation_events.event_type': EVENT_TYPES,
  'moderation_events.source': ACTOR_SOURCES,
  'moderation_events.severity': SEVERITIES,
  'moderation_events.prior_state': CONTENT_STATES,
  'user_strikes.severity': SEVERITIES,
  'moderation_reports.state': REPORT_STATES,
  'moderation_appeals.state': APPEAL_STATES,
}

const TABLE_LINE = /^create table(?: if not exists)? (?:\w+\.)?(\w+)\s*\(/
const CHECK_LINE = /^\s*(\w+)\s+text\b.*\bcheck \(\1 in \(([^)]*)\)\)/

/** Reads the migration and returns each `table.column` CHECK list as its quoted values, in file order. */
function readCheckLists(sql: string): Map<string, string[]> {
  const lists = new Map<string, string[]>()
  let table: string | null = null
  for (const line of sql.split('\n')) {
    const tableMatch = TABLE_LINE.exec(line)
    if (tableMatch) {
      table = tableMatch[1] ?? null
      continue
    }
    if (/^\);/.test(line)) {
      table = null
      continue
    }
    const checkMatch = CHECK_LINE.exec(line)
    if (!checkMatch || !table) continue
    const [, column, list] = checkMatch
    const values = [...(list ?? '').matchAll(/'([^']*)'/g)].map((m) => m[1] as string)
    lists.set(`${table}.${column}`, values)
  }
  return lists
}

describe('SQL CHECK lists match the TypeScript arrays', () => {
  const found = readCheckLists(readFileSync(MIGRATION, 'utf8'))

  it('finds every mapped CHECK list and nothing unmapped', () => {
    expect([...found.keys()].sort()).toEqual(Object.keys(CHECK_LISTS).sort())
  })

  for (const [key, expected] of Object.entries(CHECK_LISTS)) {
    it(`${key} equals its array in value and order`, () => {
      expect(found.get(key)).toEqual([...expected])
    })
  }
})
