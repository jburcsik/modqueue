// check_rate_limit through the store: within budget, over budget, and fail
// closed when the database cannot be reached.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { createSupabaseStore } from '../../src/supabase/store.js'
import { Fixtures, SERVICE_ROLE_KEY, serviceClient, type TestUser } from './helpers.js'

const client = serviceClient()
const store = createSupabaseStore(client, { onError: () => {} })
const fx = new Fixtures(client)
let user: TestUser

beforeAll(async () => {
  user = await fx.user('limited')
})

afterAll(async () => {
  await fx.cleanup()
})

describe('check_rate_limit', () => {
  it('allows up to max in the window, then refuses', async () => {
    const key = `test:${user.id}`
    expect(await store.checkRateLimit(key, 60, 2)).toBe(true)
    expect(await store.checkRateLimit(key, 60, 2)).toBe(true)
    expect(await store.checkRateLimit(key, 60, 2)).toBe(false)
  })

  it('fails closed when the RPC is unreachable', async () => {
    const errors: unknown[] = []
    const dead = createSupabaseStore(
      createClient('http://127.0.0.1:9', SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }),
      { onError: (_context, error) => errors.push(error) },
    )
    expect(await dead.checkRateLimit(`dead:${user.id}`, 60, 100)).toBe(false)
    expect(errors).toHaveLength(1)
    const reach = await dead.reachCoefficient(user.id)
    expect(reach).toMatchObject({ coefficient: 1, error: true })
  })
})
