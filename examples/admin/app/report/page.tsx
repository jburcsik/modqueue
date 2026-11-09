'use client'

import { useState, type FormEvent } from 'react'
import { browserClient } from '@/lib/supabase/browser'

/** A member files a report through the client-callable function; nothing else is written from the browser. */
export default function ReportPage() {
  const [contentId, setContentId] = useState('')
  const [reason, setReason] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setResult(null)
    setError(null)
    const { data, error } = await browserClient().rpc('file_report', {
      p_target_id: contentId.trim(),
      p_reason: reason.trim() || null,
      p_evidence_paths: [],
    })
    setBusy(false)
    if (error) setError(error.message)
    else setResult(`Report filed: ${String(data)}`)
  }

  return (
    <main className="page">
      <h1>Report content</h1>
      <p className="muted small">Members file a report here after signing in. The content id is the uuid of a visible row.</p>
      <form className="stack" onSubmit={submit}>
        <label className="field">Content id
          <input type="text" name="contentId" value={contentId} onChange={(e) => setContentId(e.target.value)} required />
        </label>
        <label className="field">Reason
          <input type="text" name="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </label>
        {error && <p className="alert error" role="alert">{error}</p>}
        {result && <p className="alert ok" role="status">{result}</p>}
        <button className="primary" type="submit" disabled={busy}>{busy ? 'Filing...' : 'File report'}</button>
      </form>
    </main>
  )
}
