import { z } from 'zod'
import type { ModerationProvider } from '../store.js'
import type { ModerationOutcome } from '../types.js'

const responseSchema = z.object({
  results: z
    .array(
      z.object({
        flagged: z.boolean(),
        categories: z.record(z.string(), z.boolean().nullable()),
        category_scores: z.record(z.string(), z.number()).refine((scores) => Object.keys(scores).length <= 64, 'too many categories'),
      }),
    )
    .min(1),
})

export interface OpenAIModerationOptions {
  apiKey: string | undefined
  /** Defaults to the vendor's rolling moderation model. */
  model?: string
  timeoutMs?: number
  endpoint?: string
  fetch?: typeof fetch
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

/**
 * The OpenAI moderation endpoint as a `ModerationProvider`. Every failure is
 * an `unavailable` outcome: a missing key, a non-2xx status, a body that does
 * not match the schema, a network error or a timeout. Nothing here is ever a
 * verdict.
 */
export function createOpenAIModerationProvider(options: OpenAIModerationOptions): ModerationProvider {
  const model = options.model ?? 'omni-moderation-latest'
  const timeoutMs = options.timeoutMs ?? 8000
  const endpoint = options.endpoint ?? 'https://api.openai.com/v1/moderations'
  const doFetch = options.fetch ?? globalThis.fetch

  return {
    name: 'openai',
    async analyze(text, signal): Promise<ModerationOutcome> {
      if (!options.apiKey) return { status: 'unavailable', reason: 'not_configured', detail: null }

      const timeout = AbortSignal.timeout(timeoutMs)
      let response: Response
      try {
        response = await doFetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify({ model, input: [{ type: 'text', text }] }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        })
      } catch (error) {
        return {
          status: 'unavailable',
          reason: isTimeout(error) ? 'timeout' : 'network_error',
          detail: error instanceof Error ? error.message : null,
        }
      }

      if (!response.ok) return { status: 'unavailable', reason: 'api_error', detail: `HTTP ${response.status}` }

      let body: unknown
      try {
        body = await response.json()
      } catch {
        return { status: 'unavailable', reason: 'invalid_response', detail: 'body is not JSON' }
      }

      const parsed = responseSchema.safeParse(body)
      if (!parsed.success) {
        return { status: 'unavailable', reason: 'invalid_response', detail: parsed.error.issues[0]?.message ?? null }
      }

      const first = parsed.data.results[0]
      if (!first) return { status: 'unavailable', reason: 'invalid_response', detail: 'no results' }
      const categories = Object.fromEntries(Object.entries(first.categories).map(([name, value]) => [name, value === true]))
      return { status: 'screened', result: { flagged: first.flagged, categories, scores: first.category_scores } }
    },
  }
}
