import type { ReachResult } from 'modqueue'

const FACTORS: { key: keyof ReachResult['factors']; label: string }[] = [
  { key: 'age', label: 'Account age' },
  { key: 'reputation', label: 'Reputation' },
  { key: 'strikes', label: 'Strikes' },
  { key: 'engagement', label: 'Engagement' },
  { key: 'farReport', label: 'Far reports' },
]

export function ReachBreakdown({ reach }: { reach: ReachResult }) {
  return (
    <div className="panel">
      <h3>Reach</h3>
      {!reach.enabled && <p className="muted small">Reach is off; the coefficient is fixed at 1.0.</p>}
      {reach.error && <p className="alert error small">Reach could not be computed; showing the neutral value.</p>}
      <dl>
        <dt>Coefficient</dt>
        <dd><strong>{reach.coefficient.toFixed(2)}</strong></dd>
        {FACTORS.map((f) => (
          <FactorRow key={String(f.key)} label={f.label} value={reach.factors[f.key]} />
        ))}
        <dt>Reputation score</dt>
        <dd>{reach.inputs.reputationScore}</dd>
        <dt>Active strike points</dt>
        <dd>{reach.inputs.activeStrikePoints}</dd>
        <dt>Account age</dt>
        <dd>{Math.round(reach.inputs.accountAgeHours)} h</dd>
        <dt>Posts / endorsed</dt>
        <dd>{reach.inputs.posts} / {reach.inputs.endorsedPosts}</dd>
        <dt>Reports received</dt>
        <dd>{reach.inputs.reportsReceived}</dd>
      </dl>
    </div>
  )
}

function FactorRow({ label, value }: { label: string; value: number }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value.toFixed(2)}</dd>
    </>
  )
}
