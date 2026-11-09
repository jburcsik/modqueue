'use client'

import { Suspense, useEffect, useState, type FormEvent } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { browserClient } from '@/lib/supabase/browser'

function LoginForm() {
  const router = useRouter()
  const params = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Enabled only after hydration, so the form can never submit natively with the password in the URL.
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await browserClient().auth.signInWithPassword({ email, password })
    setBusy(false)
    if (error) {
      setError(error.message)
      return
    }
    const next = params.get('next')
    router.push(next && next.startsWith('/') ? next : '/admin/moderation')
    router.refresh()
  }

  return (
    <main className="page login">
      <h1>Sign in</h1>
      <p className="muted small">Sign in. Moderators and admins reach the queue; members can file a report.</p>
      {params.get('denied') && <p className="alert warn">That account has no moderator or admin role. Members can <a href="/report">file a report</a>.</p>}
      <form className="stack" method="post" onSubmit={submit}>
        <label className="field">Email
          <input type="email" name="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
        </label>
        <label className="field">Password
          <input type="password" name="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        </label>
        {error && <p className="alert error" role="alert">{error}</p>}
        <button className="primary" type="submit" disabled={busy || !ready}>{busy ? 'Signing in...' : 'Sign in'}</button>
      </form>
    </main>
  )
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  )
}
