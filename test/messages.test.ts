import { describe, expect, it } from 'vitest'
import { ISSUE_TYPE_INFO, issueLabel, stockMessage } from '../src/messages.js'
import { ISSUE_TYPES, STOCK_MESSAGE_KEYS } from '../src/types.js'

const LEAKS = /\d|threshold|point|reach|coefficient|\bstrike|moderator|\bAI\b|\bbot\b|shadow|tier|automated|score/i

describe('stockMessage', () => {
  it.each(STOCK_MESSAGE_KEYS)('%s has a title and body with no number or mechanic word', (key) => {
    for (const issueType of [null, ...ISSUE_TYPES]) {
      for (const options of [{ issueType }, { issueType, brandName: 'Example Forum' }]) {
        const message = stockMessage(key, options)
        expect(message.title.length).toBeGreaterThan(0)
        expect(message.body.length).toBeGreaterThan(0)
        expect(message.title).not.toMatch(LEAKS)
        expect(message.body).not.toMatch(LEAKS)
      }
    }
  })

  it('names the issue in the warning and falls back to a generic blurb', () => {
    expect(stockMessage('warning', { issueType: 'privacy' }).body).toContain(ISSUE_TYPE_INFO.privacy.blurb)
    expect(stockMessage('warning').body).toContain('flagged for review')
  })

  it('uses the brand name when given and generic copy otherwise', () => {
    expect(stockMessage('review_gated', { brandName: 'Example Forum' }).body).toContain('Example Forum')
    expect(stockMessage('review_gated').body).toContain('this community')
    expect(stockMessage('review_gated', { brandName: '  ' }).body).toContain('this community')
  })

  it('frames restriction and pause as temporary', () => {
    expect(stockMessage('review_gated').body).toContain('temporary')
    expect(stockMessage('quieted').body).toContain('not permanent')
  })
})

describe('issue types', () => {
  it.each(ISSUE_TYPES)('%s has a label and blurb', (issueType) => {
    expect(issueLabel(issueType).length).toBeGreaterThan(0)
    expect(ISSUE_TYPE_INFO[issueType].blurb).toMatch(/^flagged/)
  })
})
