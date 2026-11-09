// Fixture people shared with supabase/seed.sql. Ids are fixed so the SQL seed
// and this script agree. The SQL seed sets the default password; this script
// sets SEED_PASSWORD on every account, so an override here wins.

export interface FixtureUser {
  id: string
  email: string
  displayName: string
  role: 'member' | 'moderator' | 'admin'
}

export const FIXTURE_USERS: FixtureUser[] = [
  { id: '10000000-0000-4000-8000-000000000001', email: 'moderator@example.com', displayName: 'Reviewer A', role: 'moderator' },
  { id: '10000000-0000-4000-8000-000000000002', email: 'admin@example.com', displayName: 'Reviewer B', role: 'admin' },
  { id: '20000000-0000-4000-8000-000000000001', email: 'member1@example.com', displayName: 'member1', role: 'member' },
  { id: '20000000-0000-4000-8000-000000000002', email: 'member2@example.com', displayName: 'member2', role: 'member' },
  { id: '20000000-0000-4000-8000-000000000003', email: 'member3@example.com', displayName: 'member3', role: 'member' },
  { id: '20000000-0000-4000-8000-000000000004', email: 'member4@example.com', displayName: 'member4', role: 'member' },
  { id: '20000000-0000-4000-8000-000000000005', email: 'member5@example.com', displayName: 'member5', role: 'member' },
  { id: '20000000-0000-4000-8000-000000000006', email: 'member6@example.com', displayName: 'member6', role: 'member' },
]

export const MODERATOR = FIXTURE_USERS[0]!
export const ADMIN = FIXTURE_USERS[1]!
export const MEMBERS = FIXTURE_USERS.filter((u) => u.role === 'member')

const DEFAULT_PASSWORD = 'modqueue-seed'

export function password(): string {
  return process.env.SEED_PASSWORD || DEFAULT_PASSWORD
}

/** Queue rows this script adds on top of the SQL seed so the first screen is never empty. */
export const SEED_CONTENT: { body: string; owner: number; state: 'visible' | 'held'; reports: string[] }[] = [
  { body: 'seed: Lost a grey cat near the park, answers to Pebble. Please message me.', owner: 0, state: 'held', reports: ['Possible duplicate of an earlier post', 'Posted in the wrong group'] },
  { body: 'seed: Selling a used bicycle, pick up only, cash. Call me any time at 555 0100.', owner: 1, state: 'visible', reports: ['Commercial listing in a community feed', 'Contains a phone number'] },
  { body: 'seed: Whoever keeps parking across my driveway, I know where you live.', owner: 2, state: 'held', reports: ['Threatening tone', 'Targets a neighbour'] },
  { body: 'seed: Reminder that the community garden opens Saturday morning.', owner: 3, state: 'visible', reports: ['Off topic for this group'] },
]
