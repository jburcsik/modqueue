import type { ModerationProvider } from '../store.js'

/** Screens everything as clean. Lets the kit run with no provider key. */
export const allowAllProvider: ModerationProvider = {
  name: 'allow_all',
  analyze: async () => ({ status: 'screened', result: { flagged: false, categories: {}, scores: {} } }),
}
