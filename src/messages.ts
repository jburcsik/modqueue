import type { IssueType, StockMessage, StockMessageKey } from './types.js'

/** Label and blurb for each issue type a reviewer may pick. */
export const ISSUE_TYPE_INFO: Record<IssueType, { label: string; blurb: string }> = {
  accuracy: { label: 'Accuracy', blurb: 'flagged for accuracy' },
  tone: { label: 'Tone', blurb: 'flagged for tone' },
  off_topic: { label: 'Off-topic', blurb: 'flagged as off-topic' },
  privacy: { label: 'Privacy', blurb: 'flagged for sharing private details' },
  duplicate: { label: 'Duplicate', blurb: 'flagged as a duplicate' },
}

export function issueLabel(issueType: IssueType): string {
  return ISSUE_TYPE_INFO[issueType].label
}

export interface StockMessageOptions {
  issueType?: IssueType | null
  /** Replaces "this community" in the copy. */
  brandName?: string
}

/**
 * Member-facing copy for a notification. The copy describes the situation
 * and never a number, threshold, point, reach value or who decided.
 */
export function stockMessage(key: StockMessageKey, options: StockMessageOptions = {}): StockMessage {
  const brand = options.brandName?.trim() || 'this community'
  switch (key) {
    case 'warning': {
      const blurb = options.issueType ? ISSUE_TYPE_INFO[options.issueType].blurb : 'flagged for review'
      return {
        title: 'A note about your recent posts',
        body:
          `Some of your recent posts were ${blurb}. Posts in ${brand} are held to a high standard, ` +
          `so this is a heads-up. Your account is in good standing and this is not a penalty. ` +
          `If you think this was a mistake, you can let us know.`,
      }
    }
    case 'review_gated':
      return {
        title: 'Your new posts will be checked first',
        body:
          `To keep ${brand} reliable, your new posts will be reviewed before they appear. ` +
          `This is temporary and lifts on its own. You can contest any decision.`,
      }
    case 'quieted':
      return {
        title: 'Posting is paused for now',
        body:
          `You can still read and take part in ${brand}, but posting is paused while repeated ` +
          `concerns are reviewed. This is not permanent. Let us know if you would like another look.`,
      }
    case 'appeal_upheld':
      return {
        title: 'Appeal reviewed',
        body: 'We reviewed your appeal and are standing by the original decision. Your account standing has not changed.',
      }
    case 'appeal_overturned':
      return {
        title: 'Decision reversed',
        body:
          'We reviewed your appeal and have reversed the original decision. Any content that was removed ' +
          'has been restored and your account standing is updated.',
      }
  }
}
