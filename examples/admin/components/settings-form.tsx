'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { AUTOMATION_LEVELS } from 'modqueue'
import type { AutomationLevel, Settings } from 'modqueue'
import { describe, send } from '@/lib/client-api'

const LEVEL_HELP: Record<AutomationLevel, string> = {
  off: 'No automated scoring. Every submission waits for a person.',
  assist: 'Scores are recorded as advice. People take every action.',
  semi_auto: 'Clean submissions pass; borderline ones are held for a person.',
  full_auto: 'Automated review acts on its own above the confidence floor. People audit the log.',
}

function toLines(list: string[]): string {
  return list.join('\n')
}

function fromLines(raw: string): string[] {
  return raw.split('\n').map((s) => s.trim()).filter((s) => s.length > 0)
}

export function SettingsForm({ initial, canSave }: { initial: Settings; canSave: boolean }) {
  const router = useRouter()
  const [level, setLevel] = useState<AutomationLevel>(initial.automationLevel)
  const [warn, setWarn] = useState(initial.warnThreshold)
  const [hold, setHold] = useState(initial.holdThreshold)
  const [confidence, setConfidence] = useState(initial.autoActionConfidence)
  const [warnWords, setWarnWords] = useState(toLines(initial.autoWarnKeywords))
  const [blockWords, setBlockWords] = useState(toLines(initial.autoBlockKeywords))
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const needsAck = level === 'full_auto' && !initial.fullAutoAcknowledgedAt

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSaved(false)
    if (needsAck && !acknowledged) {
      setError('Tick the acknowledgement before saving full_auto.')
      return
    }
    setBusy(true)
    try {
      await send('/api/admin/moderation/settings', 'PUT', {
        automationLevel: level,
        warnThreshold: warn,
        holdThreshold: hold,
        autoActionConfidence: confidence,
        autoWarnKeywords: fromLines(warnWords),
        autoBlockKeywords: fromLines(blockWords),
        fullAutoAcknowledgedAt:
          level === 'full_auto' ? (initial.fullAutoAcknowledgedAt ?? new Date().toISOString()) : initial.fullAutoAcknowledgedAt,
      })
      setSaved(true)
      router.refresh()
    } catch (err) {
      setError(describe(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <h2>Automation level</h2>
      {AUTOMATION_LEVELS.map((l) => (
        <label key={l} className="check">
          <input type="radio" name="automationLevel" value={l} checked={level === l} onChange={() => setLevel(l)} disabled={!canSave} />
          <span><strong>{l}</strong> <span className="muted">{LEVEL_HELP[l]}</span></span>
        </label>
      ))}
      {level === 'full_auto' && (
        <label className="check">
          <input type="checkbox" name="acknowledge" checked={acknowledged || !!initial.fullAutoAcknowledgedAt} onChange={(e) => setAcknowledged(e.target.checked)} disabled={!canSave || !!initial.fullAutoAcknowledgedAt} />
          <span>I understand that full_auto removes content and adds strikes without a person looking first.</span>
        </label>
      )}

      <h2>Thresholds</h2>
      <div className="grid">
        <label className="field">Warn at score
          <input type="number" name="warnThreshold" min={0} max={1} step={0.01} value={warn} onChange={(e) => setWarn(Number(e.target.value))} disabled={!canSave} />
        </label>
        <label className="field">Hold at score
          <input type="number" name="holdThreshold" min={0} max={1} step={0.01} value={hold} onChange={(e) => setHold(Number(e.target.value))} disabled={!canSave} />
        </label>
        <label className="field">Automated action confidence
          <input type="number" name="autoActionConfidence" min={0} max={1} step={0.01} value={confidence} onChange={(e) => setConfidence(Number(e.target.value))} disabled={!canSave} />
        </label>
      </div>

      <h2>Keyword lists</h2>
      <p className="muted small">One term per line. Lowercase substrings matched against normalized text.</p>
      <div className="grid">
        <label className="field">Warn keywords
          <textarea name="autoWarnKeywords" value={warnWords} onChange={(e) => setWarnWords(e.target.value)} disabled={!canSave} />
        </label>
        <label className="field">Block keywords
          <textarea name="autoBlockKeywords" value={blockWords} onChange={(e) => setBlockWords(e.target.value)} disabled={!canSave} />
        </label>
      </div>

      {error && <p className="alert error" role="alert" data-testid="settings-error">{error}</p>}
      {saved && <p className="alert ok" role="status">Saved.</p>}
      {canSave ? (
        <div className="row"><button className="primary" type="submit" disabled={busy}>{busy ? 'Saving...' : 'Save settings'}</button></div>
      ) : (
        <p className="muted small">Only an admin can save.</p>
      )}
    </form>
  )
}
