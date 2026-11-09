import { listPendingAppeals } from 'modqueue/supabase'
import { handle } from '@/lib/api'
import { requireRole } from '@/lib/kit'

export async function GET() {
  return handle(async () => {
    const { store } = await requireRole('moderator')
    return { appeals: await listPendingAppeals(store) }
  })
}
