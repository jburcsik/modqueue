import { listPendingAppeals } from 'modqueue/supabase'
import { requireRole } from '@/lib/kit'
import { AppealsList, type AppealListRow } from '@/components/appeals-list'

export default async function AppealsPage() {
  const { store } = await requireRole('moderator')
  const appeals = await listPendingAppeals(store)
  const strikes = await Promise.all(appeals.map((a) => store.getStrike(a.strikeId)))
  const rows: AppealListRow[] = appeals.map((appeal, i) => ({ appeal, strike: strikes[i] ?? null }))
  return (
    <>
      <h1>Pending appeals</h1>
      <p className="muted small">Overturn revokes the strike and restores the content when the strike came from a case.</p>
      <AppealsList rows={rows} />
    </>
  )
}
