'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { AppealResolution, AppealRow, StrikeRow } from 'modqueue'
import { describe, send } from '@/lib/client-api'
import { timeAgo } from '@/lib/format'

export interface AppealListRow {
  appeal: AppealRow
  strike: StrikeRow | null
}

export function AppealsList({ rows }: { rows: AppealListRow[] }) {
  if (rows.length === 0) return <p className="muted">No pending appeals.</p>
  return <div>{rows.map((r) => <AppealCard key={r.appeal.id} row={r} />)}</div>
}

function AppealCard({ row }: { row: AppealListRow }) {
  const router = useRouter()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { appeal, strike } = row

  async function resolve(resolution: AppealResolution) {
    setBusy(true)
    setError(null)
    try {
      await send(`/api/admin/moderation/appeals/${appeal.id}/resolve`, 'POST', { resolution, reviewer_note: note.trim() || null })
      router.refresh()
    } catch (err) {
      setError(describe(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="card" data-testid="appeal" data-appeal-id={appeal.id} data-strike-id={appeal.strikeId}>
      <div className="meta">
        <span className={`badge ${appeal.state}`}>{appeal.state}</span>
        <span>filed {timeAgo(appeal.createdAt)}</span>
        {strike && <span className={`badge ${strike.severity}`}>{strike.severity}, {strike.points} points</span>}
        {strike && <span>strike reason: {strike.reason}</span>}
      </div>
      <p className="preview">{appeal.statement}</p>
      <div className="stack">
        <label className="field">Reviewer note
          <textarea name="note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
        </label>
        {error && <p className="alert error" role="alert" data-testid="appeal-error">{error}</p>}
        <div className="row">
          <button type="button" onClick={() => resolve('uphold')} disabled={busy}>Uphold strike</button>
          <button type="button" className="primary" onClick={() => resolve('overturn')} disabled={busy}>Overturn</button>
        </div>
      </div>
    </article>
  )
}
