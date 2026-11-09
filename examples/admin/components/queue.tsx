'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { MODERATION_OPS } from 'modqueue'
import type { ModerationOp, QueueFilter, QueueItem, ReportRow, Role, Severity } from 'modqueue'
import { describe, send } from '@/lib/client-api'
import { timeAgo, weightSum } from '@/lib/format'
import { ReachBreakdown } from '@/components/reach-breakdown'
import { EventLog } from '@/components/event-log'

const OP_LABEL: Record<ModerationOp, string> = {
  approve: 'Approve (keep visible, close case)',
  dismiss: 'Dismiss reports (close case)',
  remove: 'Remove content (close case)',
  hold: 'Hold for review',
  warn: 'Warn the member',
  note: 'Add a note only',
}

const NEEDS_REASON: ReadonlySet<ModerationOp> = new Set(['remove', 'warn', 'hold', 'note'])

type StrikeOption = { value: Severity; label: string }
type ClaimAction = 'claim' | 'release' | 'take_over'
type Run = (fn: () => Promise<unknown>) => Promise<boolean>

interface Props {
  items: QueueItem[]
  filter: QueueFilter
  role: Role
  userId: string
  openCaseId: string | null
  strikeOptions: StrikeOption[]
}

export function Queue({ items, filter, role, userId, openCaseId, strikeOptions }: Props) {
  const [expanded, setExpanded] = useState<string | null>(openCaseId)
  useEffect(() => setExpanded(openCaseId), [openCaseId])

  if (items.length === 0) return <p className="muted">Nothing in the {filter} view.</p>

  return (
    <div>
      {items.map((item) => (
        <CaseCard
          key={item.caseId}
          item={item}
          role={role}
          userId={userId}
          expanded={expanded === item.caseId}
          onToggle={() => setExpanded(expanded === item.caseId ? null : item.caseId)}
          strikeOptions={strikeOptions}
        />
      ))}
    </div>
  )
}

interface CardProps {
  item: QueueItem
  role: Role
  userId: string
  expanded: boolean
  onToggle: () => void
  strikeOptions: StrikeOption[]
}

function CaseCard({ item, role, userId, expanded, onToggle, strikeOptions }: CardProps) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const mine = item.claimedBy === userId
  const claimedByOther = item.claimedBy !== null && !mine
  const settled = item.caseState === 'decided' || item.caseState === 'reversed'

  const run: Run = async (fn) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      router.refresh()
      return true
    } catch (err) {
      setError(describe(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  const claim = (action: ClaimAction) => run(() => send('/api/admin/moderation/claim', 'POST', { case_id: item.caseId, action }))

  return (
    <article id={`case-${item.caseId}`} className={expanded ? 'card open' : 'card'} data-testid="case" data-case-id={item.caseId} data-case-state={item.caseState}>
      <div className="head">
        <p className="preview">{item.preview ?? <span className="muted">(no preview)</span>}</p>
        <button type="button" onClick={onToggle} aria-expanded={expanded}>{expanded ? 'Close' : 'Open'}</button>
      </div>
      <div className="meta">
        <span className={`badge ${item.caseState}`} data-testid="case-state">{item.caseState}</span>
        <span className={`badge ${item.moderationState}`} data-testid="content-state">{item.moderationState}</span>
        <span>weight {weightSum(item.reports)}</span>
        <span>{item.openReportCount} open of {item.totalReportCount} reports</span>
        <span>{item.ownerStrikePoints} strike points</span>
        <span>opened {timeAgo(item.caseCreatedAt)}</span>
        {item.ownerDisplayName && <span>owner {item.ownerDisplayName}</span>}
        {item.claimedBy && <span>{mine ? 'claimed by you' : 'claimed by another moderator'}</span>}
      </div>

      {expanded && (
        <div>
          {!settled && (
            <ClaimControls
              unclaimed={!item.claimedBy}
              mine={mine}
              canTakeOver={claimedByOther && role === 'admin'}
              busy={busy}
              onClaim={claim}
            />
          )}

          <h3>Reports</h3>
          <ReportList reports={item.reports} />

          {item.ownerReach && <ReachBreakdown reach={item.ownerReach} />}

          <h3>Events</h3>
          <EventLog events={item.events} />

          {!settled && (
            <ActionForm
              contentId={item.contentId}
              caseId={item.caseId}
              strikeOptions={strikeOptions}
              busy={busy}
              error={error}
              setError={setError}
              run={run}
            />
          )}
          {settled && error && <p className="alert error" role="alert" data-testid="action-error">{error}</p>}
        </div>
      )}
    </article>
  )
}

interface ClaimProps {
  unclaimed: boolean
  mine: boolean
  canTakeOver: boolean
  busy: boolean
  onClaim: (action: ClaimAction) => void
}

function ClaimControls({ unclaimed, mine, canTakeOver, busy, onClaim }: ClaimProps) {
  return (
    <div className="row controls">
      {unclaimed && <button type="button" onClick={() => onClaim('claim')} disabled={busy}>Claim</button>}
      {mine && <button type="button" onClick={() => onClaim('release')} disabled={busy}>Release</button>}
      {canTakeOver && <button type="button" onClick={() => onClaim('take_over')} disabled={busy}>Take over</button>}
    </div>
  )
}

function ReportList({ reports }: { reports: ReportRow[] }) {
  if (reports.length === 0) return <p className="muted small">No reports; this case was opened by a hold.</p>
  return (
    <>
      {reports.map((r) => (
        <p key={r.id} className="small">
          <span className={`badge ${r.state === 'open' ? 'report-open' : ''}`}>{r.state}</span>{' '}
          weight {r.trustWeight.toFixed(2)}, {timeAgo(r.createdAt)}: {r.reason ?? <span className="muted">(no reason)</span>}
        </p>
      ))}
    </>
  )
}

interface ActionProps {
  contentId: string
  caseId: string
  strikeOptions: StrikeOption[]
  busy: boolean
  error: string | null
  setError: (message: string | null) => void
  run: Run
}

function ActionForm({ contentId, caseId, strikeOptions, busy, error, setError, run }: ActionProps) {
  const [op, setOp] = useState<ModerationOp>('approve')
  const [severity, setSeverity] = useState<Severity | ''>('')
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const reasonRef = useRef<HTMLInputElement>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if ((NEEDS_REASON.has(op) || severity) && !reason.trim()) {
      setError('A reason is required for this action.')
      reasonRef.current?.focus()
      return
    }
    const ok = await run(() =>
      send('/api/admin/moderation/action', 'POST', {
        target_id: contentId,
        target_type: 'content',
        case_id: caseId,
        op,
        reason: reason.trim() || null,
        note: note.trim() || null,
        strike_severity: severity || null,
      }),
    )
    if (ok) {
      setReason('')
      setNote('')
      setSeverity('')
    }
  }

  return (
    <form className="stack action" onSubmit={submit}>
      <h3>Action</h3>
      <label className="field">Operation
        <select name="op" value={op} onChange={(e) => setOp(e.target.value as ModerationOp)}>
          {MODERATION_OPS.map((o) => <option key={o} value={o}>{OP_LABEL[o]}</option>)}
        </select>
      </label>
      <label className="field">Strike
        <select name="severity" value={severity} onChange={(e) => setSeverity(e.target.value as Severity | '')}>
          <option value="">No strike</option>
          {strikeOptions.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </label>
      <label className="field">Reason
        <input ref={reasonRef} type="text" name="reason" value={reason} onChange={(e) => { setReason(e.target.value); if (error) setError(null) }} maxLength={500} />
      </label>
      <label className="field">Note to other moderators
        <textarea name="note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      </label>
      {error && <p className="alert error" role="alert" data-testid="action-error">{error}</p>}
      <div className="row">
        <button className={op === 'remove' ? 'danger' : 'primary'} type="submit" disabled={busy}>
          {busy ? 'Working...' : 'Apply'}
        </button>
      </div>
    </form>
  )
}
