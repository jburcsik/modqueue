import type { ModerationConfig } from '../config.js'
import type { ModerationProvider } from '../store.js'
import type { FilterResult, ModerationDecision, Settings } from '../types.js'
import { scoreContent } from '../scoring.js'
import { normalizeText } from './normalize.js'
import { detectTripwire } from './tripwire.js'

/**
 * Local checks with no network: normalize, tripwire, PII warnings, profiling
 * phrases and blocked terms (both block), and the minimum length warning.
 */
export function filterContent(text: string, config: ModerationConfig): FilterResult {
  const { filter } = config
  const normalizer = normalizeText(text)
  const clean = normalizer.clean
  const tripwire = detectTripwire(clean, config.tripwire)
  const warnings: string[] = []
  const piiFound: string[] = []

  if (normalizer.suspicious) warnings.push('normalizer_stripped')

  for (const { name, pattern } of filter.piiPatterns) {
    if (clean.search(pattern) !== -1) {
      piiFound.push(name)
      warnings.push(`Possible ${name} detected: consider removing personal information`)
    }
  }

  const base = { clean, warnings, piiFound, normalizer, tripwire }

  if (filter.profilingPhrases.some((pattern) => clean.search(pattern) !== -1)) {
    return { ...base, blocked: true, reason: filter.profilingMessage }
  }

  const lower = clean.toLowerCase()
  if (filter.blockedTerms.some((term) => term !== '' && lower.includes(term.toLowerCase()))) {
    return { ...base, blocked: true, reason: filter.blockedTermsMessage }
  }

  if (clean.length < filter.minLengthChars) warnings.push('too_short')

  return { ...base, blocked: false, reason: null }
}

export interface ModerateTextResult {
  clean: string
  blocked: boolean
  reason: string | null
  filter: FilterResult
  /** Null when the local filter blocked and the provider was not called. */
  decision: ModerationDecision | null
}

/** Local filter, then provider scoring on the normalized text. */
export async function moderateText(
  text: string,
  settings: Settings,
  provider: ModerationProvider,
  config: ModerationConfig,
): Promise<ModerateTextResult> {
  const filter = filterContent(text, config)
  if (filter.blocked) return { clean: filter.clean, blocked: true, reason: filter.reason, filter, decision: null }
  const decision = await scoreContent(filter.clean, settings, provider, config)
  return { clean: filter.clean, blocked: false, reason: null, filter, decision }
}
