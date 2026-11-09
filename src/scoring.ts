import type { ModerationConfig, ScoringConfig } from './config.js'
import type { ModerationProvider } from './store.js'
import type { ModerationDecision, ModerationOutcome, Settings } from './types.js'

function allow(providerUnavailable: boolean): ModerationDecision {
  return { tier: 'allow', severity: null, flaggedCategories: [], scores: {}, confidence: 0, reason: null, providerUnavailable }
}

function readable(category: string): string {
  return category.replace(/\//g, ' / ')
}

function keywordHit(lower: string, keywords: string[]): boolean {
  return keywords.some((keyword) => keyword !== '' && lower.includes(keyword.toLowerCase()))
}

/**
 * Maps a provider outcome to a decision tier. An unavailable provider is an
 * allow with confidence 0 and `providerUnavailable` true, never a verdict.
 */
export function decideTier(outcome: ModerationOutcome, settings: Settings, config: ScoringConfig): ModerationDecision {
  if (outcome.status === 'unavailable') return allow(true)
  const { result } = outcome
  const scores = result.scores
  const confidence = Object.values(scores).reduce((max, score) => Math.max(max, score), 0)
  const flaggedCategories = Object.entries(result.categories)
    .filter(([, flagged]) => flagged)
    .map(([name]) => name)
  const common = { scores, confidence, providerUnavailable: false }

  for (const category of config.severeCategories) {
    const score = scores[category]
    if (score !== undefined && score > config.severeScoreFloor) {
      return {
        ...common,
        tier: 'hold',
        severity: 'severe',
        flaggedCategories: flaggedCategories.includes(category) ? flaggedCategories : [...flaggedCategories, category],
        reason: `Content held: ${readable(category)} detected`,
      }
    }
  }

  if (result.flagged) {
    return {
      ...common,
      tier: 'hold',
      severity: 'violation',
      flaggedCategories,
      reason: `Content held for: ${flaggedCategories.map(readable).join(', ')}`,
    }
  }

  if (confidence >= settings.holdThreshold) {
    return {
      ...common,
      tier: 'hold',
      severity: 'violation',
      flaggedCategories: Object.keys(scores).filter((name) => (scores[name] ?? 0) >= settings.holdThreshold),
      reason: 'Content held: high risk score',
    }
  }

  if (confidence >= settings.warnThreshold) {
    return {
      ...common,
      tier: 'warn',
      severity: 'warning',
      flaggedCategories: Object.keys(scores).filter((name) => (scores[name] ?? 0) >= settings.warnThreshold),
      reason: 'Content contains potentially sensitive language',
    }
  }

  if (confidence >= config.allowLogFloor) {
    return { ...common, tier: 'allow_log', severity: 'info', flaggedCategories: [], reason: null }
  }

  return { ...common, tier: 'allow', severity: null, flaggedCategories: [], reason: null }
}

/**
 * Scores normalized text. Automation `off` allows everything; block keywords
 * hold with confidence 1 before the provider is called; warn keywords raise an
 * allow to a warn and never lower a verdict.
 */
export async function scoreContent(
  text: string,
  settings: Settings,
  provider: ModerationProvider,
  config: ModerationConfig,
): Promise<ModerationDecision> {
  if (settings.automationLevel === 'off') return allow(false)

  const lower = text.toLowerCase()
  if (keywordHit(lower, settings.autoBlockKeywords)) {
    return {
      tier: 'hold',
      severity: 'violation',
      flaggedCategories: ['keyword_block'],
      scores: {},
      confidence: 1,
      reason: 'Content matches a configured block list.',
      providerUnavailable: false,
    }
  }

  const decision = decideTier(await provider.analyze(text), settings, config.scoring)

  if ((decision.tier === 'allow' || decision.tier === 'allow_log') && keywordHit(lower, settings.autoWarnKeywords)) {
    return {
      ...decision,
      tier: 'warn',
      severity: 'warning',
      flaggedCategories: [...decision.flaggedCategories, 'keyword_warn'],
      reason: 'Content matches a configured warning term.',
    }
  }

  return decision
}
