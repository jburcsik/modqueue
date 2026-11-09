import { vi } from 'vitest'
import { createFixedClock, type FixedClock } from '../src/clock.js'
import { defaultConfig, mergeConfig, type DeepPartial, type ModerationConfig } from '../src/config.js'
import { createInMemoryStore, type InMemoryStore } from '../src/memory-store.js'
import { createFixtureProvider, type FixtureProvider, type FixtureProviderOptions } from '../src/provider/fixture.js'
import type { Notifier, PipelineDeps } from '../src/store.js'
import type { ReputationInputs, Settings } from '../src/types.js'

export const HOUR_MS = 60 * 60 * 1000
export const DAY_MS = 24 * HOUR_MS

/** A fixed instant every test can reason from. */
export const NOW_MS = Date.parse('2030-06-01T12:00:00.000Z')

export const USER_A = '11111111-1111-4111-8111-111111111111'
export const USER_B = '22222222-2222-4222-8222-222222222222'
export const REVIEWER_A = '33333333-3333-4333-8333-333333333333'
export const ADMIN_A = '44444444-4444-4444-8444-444444444444'

export function hoursAgo(hours: number, nowMs = NOW_MS): string {
  return new Date(nowMs - hours * HOUR_MS).toISOString()
}

export function reputation(overrides: Partial<ReputationInputs> = {}): ReputationInputs {
  return {
    user_id: USER_A,
    account_created_at: hoursAgo(1000),
    posts: 0,
    endorsed_posts: 0,
    endorsements_given: 0,
    reports_received: 0,
    far_rate: null,
    ...overrides,
  }
}

export interface SpyNotifier extends Notifier {
  onTierEscalated: ReturnType<typeof vi.fn<Notifier['onTierEscalated']>>
  onAppealResolved: ReturnType<typeof vi.fn<Notifier['onAppealResolved']>>
  onContentApproved: ReturnType<typeof vi.fn<Notifier['onContentApproved']>>
}

export function spyNotifier(): SpyNotifier {
  return {
    onTierEscalated: vi.fn<Notifier['onTierEscalated']>(async () => {}),
    onAppealResolved: vi.fn<Notifier['onAppealResolved']>(async () => {}),
    onContentApproved: vi.fn<Notifier['onContentApproved']>(async () => {}),
  }
}

export interface TestDeps extends PipelineDeps {
  store: InMemoryStore
  provider: FixtureProvider
  notifier: SpyNotifier
  clock: FixedClock
}

export interface TestDepsOptions {
  config?: DeepPartial<ModerationConfig>
  settings?: Partial<Settings>
  provider?: FixtureProviderOptions
}

/** Store, fixture provider, spy notifier and fixed clock on the default config. */
export function makeDeps(options: TestDepsOptions = {}): TestDeps {
  const config = mergeConfig(defaultConfig, { ...options.config, settings: { ...defaultConfig.settings, ...options.settings } })
  const clock = createFixedClock(NOW_MS)
  const store = createInMemoryStore(clock, config)
  store.addUser({ id: USER_A, createdAt: hoursAgo(1000) })
  store.addUser({ id: USER_B, createdAt: hoursAgo(1000) })
  store.addUser({ id: REVIEWER_A, createdAt: hoursAgo(5000) })
  store.addUser({ id: ADMIN_A, createdAt: hoursAgo(5000) })
  store.setRole({ userId: REVIEWER_A, role: 'moderator', displayName: 'Reviewer A' })
  store.setRole({ userId: ADMIN_A, role: 'admin', displayName: 'Admin A' })
  return { store, provider: createFixtureProvider(options.provider), notifier: spyNotifier(), clock, config }
}

export function settingsWith(overrides: Partial<Settings>): Settings {
  return { ...defaultConfig.settings, ...overrides }
}
