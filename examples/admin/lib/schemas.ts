import { z } from 'zod'
import { claimCaseSchema, moderationActionSchema } from 'modqueue'

/** Body of POST /api/admin/moderation/action: the kit's action request plus an optional note. */
const actionBodySchema = moderationActionSchema.and(z.object({ note: z.string().trim().max(1000).nullable().optional() }))

export function parseActionBody(body: unknown) {
  const parsed = actionBodySchema.parse(body)
  return { ...parsed, note: parsed.note?.trim() || null }
}

/** Body of POST /api/admin/moderation/claim: the kit's claim request plus which move to make. */
export const claimBodySchema = claimCaseSchema.extend({
  action: z.enum(['claim', 'release', 'take_over']),
})
