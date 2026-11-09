import { resolveAppealSchema } from 'modqueue'
import { resolveAppeal } from 'modqueue/supabase'
import { handle, readJson } from '@/lib/api'
import { notifier, requireRole } from '@/lib/kit'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { principal, store } = await requireRole('moderator')
    const raw = await readJson(request)
    const body = resolveAppealSchema.parse({ ...(typeof raw === 'object' && raw ? raw : {}), appeal_id: (await params).id })
    const result = await resolveAppeal(store, notifier, {
      appealId: body.appeal_id,
      resolution: body.resolution,
      actorId: principal.userId,
      actorRole: principal.role,
      note: body.reviewer_note?.trim() || null,
    })
    return { appeal: result.appeal, strikeRevoked: result.strikeRevoked, eventId: result.eventId }
  })
}
