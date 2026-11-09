import { ModerationError } from 'modqueue'
import { handle } from '@/lib/api'
import { readQueue, requireRole } from '@/lib/kit'
import { UUID_RE, parseFilter } from '@/lib/queue'

export async function GET(request: Request) {
  return handle(async () => {
    const { principal, store } = await requireRole('moderator')
    const url = new URL(request.url)
    const owner = url.searchParams.get('owner')
    if (owner && !UUID_RE.test(owner)) throw new ModerationError('invalid_input', 'owner must be a uuid')
    const items = await readQueue(store, principal, parseFilter(url.searchParams.get('filter') ?? undefined), owner)
    return { items, caller: { userId: principal.userId, role: principal.role } }
  })
}
