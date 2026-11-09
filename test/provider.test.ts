import { describe, expect, it, vi } from 'vitest'
import { allowAllProvider } from '../src/provider/allow-all.js'
import { createFixtureProvider, screened, unavailable } from '../src/provider/fixture.js'
import { createOpenAIModerationProvider } from '../src/provider/openai.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const apiResult = {
  results: [
    {
      flagged: true,
      categories: { harassment: true, hate: false, 'self-harm': null },
      category_scores: { harassment: 0.91, hate: 0.02, 'self-harm': 0.001 },
    },
  ],
}

describe('createOpenAIModerationProvider', () => {
  it('posts the text with the key and maps a flagged response', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(apiResult))
    const provider = createOpenAIModerationProvider({ apiKey: 'test-key', fetch: fetchMock, model: 'test-model' })
    const outcome = await provider.analyze('some text')
    expect(outcome).toEqual({
      status: 'screened',
      result: { flagged: true, categories: { harassment: true, hate: false, 'self-harm': false }, scores: { harassment: 0.91, hate: 0.02, 'self-harm': 0.001 } },
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/moderations')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key')
    expect(JSON.parse(init.body as string)).toEqual({ model: 'test-model', input: [{ type: 'text', text: 'some text' }] })
    expect(provider.name).toBe('openai')
  })

  it('maps an unflagged response', async () => {
    const provider = createOpenAIModerationProvider({
      apiKey: 'k',
      fetch: async () => jsonResponse({ results: [{ flagged: false, categories: { hate: false }, category_scores: { hate: 0.01 } }] }),
    })
    expect(await provider.analyze('x')).toMatchObject({ status: 'screened', result: { flagged: false, scores: { hate: 0.01 } } })
  })

  it('is unavailable with not_configured when there is no key', async () => {
    const fetchMock = vi.fn()
    const provider = createOpenAIModerationProvider({ apiKey: undefined, fetch: fetchMock })
    expect(await provider.analyze('x')).toEqual({ status: 'unavailable', reason: 'not_configured', detail: null })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is unavailable with api_error on a non-2xx status', async () => {
    const provider = createOpenAIModerationProvider({ apiKey: 'k', fetch: async () => jsonResponse({ error: 'rate limited' }, 429) })
    expect(await provider.analyze('x')).toEqual({ status: 'unavailable', reason: 'api_error', detail: 'HTTP 429' })
  })

  it('is unavailable with invalid_response on a body that does not match', async () => {
    const provider = createOpenAIModerationProvider({ apiKey: 'k', fetch: async () => jsonResponse({ results: [] }) })
    expect(await provider.analyze('x')).toMatchObject({ status: 'unavailable', reason: 'invalid_response' })
    const notJson = createOpenAIModerationProvider({ apiKey: 'k', fetch: async () => new Response('nope', { status: 200 }) })
    expect(await notJson.analyze('x')).toMatchObject({ status: 'unavailable', reason: 'invalid_response' })
  })

  it('is unavailable with timeout when the request exceeds the limit', async () => {
    const hanging: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    const provider = createOpenAIModerationProvider({ apiKey: 'k', fetch: hanging, timeoutMs: 10 })
    expect(await provider.analyze('x')).toMatchObject({ status: 'unavailable', reason: 'timeout' })
  })

  it('is unavailable with network_error when fetch throws', async () => {
    const provider = createOpenAIModerationProvider({ apiKey: 'k', fetch: async () => { throw new Error('connection reset') } })
    expect(await provider.analyze('x')).toEqual({ status: 'unavailable', reason: 'network_error', detail: 'connection reset' })
  })
})

describe('fixture and allow-all providers', () => {
  it('returns the configured outcome per text and the fallback otherwise', async () => {
    const provider = createFixtureProvider({ byText: { bad: screened({ hate: 0.9 }, true) }, fallback: unavailable('timeout') })
    expect(await provider.analyze('bad')).toMatchObject({ status: 'screened', result: { flagged: true } })
    expect(await provider.analyze('other')).toEqual({ status: 'unavailable', reason: 'timeout', detail: null })
    expect(provider.calls).toEqual(['bad', 'other'])
  })

  it('screens everything as clean by default', async () => {
    expect(await createFixtureProvider().analyze('x')).toEqual({ status: 'screened', result: { flagged: false, categories: {}, scores: {} } })
    expect(await allowAllProvider.analyze('x')).toEqual({ status: 'screened', result: { flagged: false, categories: {}, scores: {} } })
  })
})
