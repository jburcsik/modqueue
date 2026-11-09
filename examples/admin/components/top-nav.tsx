'use client'

import Link from 'next/link'
import type { Role } from 'modqueue'
import { usePathname, useRouter } from 'next/navigation'
import { browserClient } from '@/lib/supabase/browser'

const LINKS = [
  { href: '/admin/moderation', label: 'Queue' },
  { href: '/admin/moderation/appeals', label: 'Appeals' },
  { href: '/admin/moderation/settings', label: 'Settings' },
]

export function TopNav({ role, name }: { role: Role; name: string }) {
  const pathname = usePathname()
  const router = useRouter()

  async function signOut() {
    await browserClient().auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <nav className="top">
      <span className="brand">modqueue</span>
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} className={pathname === l.href ? 'active' : ''} aria-current={pathname === l.href ? 'page' : undefined}>
          {l.label}
        </Link>
      ))}
      <Link href="/report">Report</Link>
      <span className="who">{name} ({role})</span>
      <button type="button" onClick={signOut}>Sign out</button>
    </nav>
  )
}
