import type { ModerationProvider } from '../store.js'
import type { ModerationOutcome, ProviderUnavailableReason } from '../types.js'

/** A screened outcome from category scores; `flagged` defaults to false. */
export function screened(scores: Record<string, number>, flagged = false): ModerationOutcome {
  const categories = Object.fromEntries(Object.keys(scores).map((name) => [name, flagged]))
  return { status: 'screened', result: { flagged, categories, scores } }
}

export function unavailable(reason: ProviderUnavailableReason, detail: string | null = null): ModerationOutcome {
  return { status: 'unavailable', reason, detail }
}

export interface FixtureProviderOptions {
  /** Outcome per exact normalized text. */
  byText?: Record<string, ModerationOutcome>
  /** Outcome for any other text; clean when omitted. */
  fallback?: ModerationOutcome
}

export interface FixtureProvider extends ModerationProvider {
  /** Every text analyzed, in order. */
  readonly calls: string[]
}

/** Returns the outcome configured for each text. For tests and examples. */
export function createFixtureProvider(options: FixtureProviderOptions = {}): FixtureProvider {
  const calls: string[] = []
  const fallback = options.fallback ?? screened({})
  return {
    name: 'fixture',
    calls,
    analyze: async (text) => {
      calls.push(text)
      return options.byText?.[text] ?? fallback
    },
  }
}
