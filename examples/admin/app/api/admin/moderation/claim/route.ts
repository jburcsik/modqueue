import { claimCase, releaseCase, takeOverCase } from 'modqueue/supabase'
import { handle, readJson } from '@/lib/api'
import { requireRole } from '@/lib/kit'
import { claimBodySchema } from '@/lib/schemas'

export async function POST(request: Request) {
  return handle(async () => {
    const { principal, store } = await requireRole('moderator')
    const body = claimBodySchema.parse(await readJson(request))
    const input = { caseId: body.case_id, actorId: principal.userId, actorRole: principal.role }
    const fn = body.action === 'claim' ? claimCase : body.action === 'release' ? releaseCase : takeOverCase
    return { case: await fn(store, input) }
  })
}
