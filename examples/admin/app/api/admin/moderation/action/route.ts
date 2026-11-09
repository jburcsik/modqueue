import { ModerationError, applyModerationAction, defaultConfig } from 'modqueue'
import type { ModerationActionInput } from 'modqueue'
import { handle, readJson } from '@/lib/api'
import { notifier, requireRole } from '@/lib/kit'
import { parseActionBody } from '@/lib/schemas'
import { serviceClient } from '@/lib/supabase/server'

export async function POST(request: Request) {
  return handle(async () => {
    const { principal, store } = await requireRole('moderator')
    const body = parseActionBody(await readJson(request))
    if (body.target_type !== 'content') throw new ModerationError('invalid_input', 'this example acts on content only')

    // The owner comes from the content row, never from the browser.
    const { data: content } = await serviceClient()
      .from('moderation_content')
      .select('owner_id')
      .eq('id', body.target_id)
      .maybeSingle()
    if (!content) throw new ModerationError('not_found', 'content not found')

    const reason = body.reason?.trim() || null
    const base: ModerationActionInput = {
      targetType: 'content',
      targetId: body.target_id,
      op: body.op,
      actor: principal.role === 'admin' ? 'admin' : 'moderator',
      actorId: principal.userId,
      actorName: principal.displayName,
      reason,
      confidence: null,
      strike: body.strike_severity && reason ? { severity: body.strike_severity, reason } : null,
      ownerId: content.owner_id as string,
      issueType: body.issue_type ?? null,
      caseId: body.case_id ?? null,
    }
    const result = await applyModerationAction(store, notifier, base, defaultConfig)

    let noteEventId: string | null = null
    if (body.note && body.op !== 'note') {
      const noted = await applyModerationAction(store, notifier, { ...base, op: 'note', reason: body.note, strike: null }, defaultConfig)
      noteEventId = noted.eventId
    }
    return { result, noteEventId }
  })
}
