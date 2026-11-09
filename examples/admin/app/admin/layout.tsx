import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { ModerationError } from 'modqueue'
import type { Principal } from 'modqueue'
import { requireRole } from '@/lib/kit'
import { TopNav } from '@/components/top-nav'

// Every admin page reads the session and the database on each request.
export const dynamic = 'force-dynamic'

export default async function AdminLayout({ children }: { children: ReactNode }) {
  let principal: Principal
  try {
    principal = (await requireRole('moderator')).principal
  } catch (err) {
    if (ModerationError.is(err) && err.code === 'forbidden') redirect('/login?denied=1')
    redirect('/login')
  }
  return (
    <>
      <TopNav role={principal.role} name={principal.displayName ?? principal.userId.slice(0, 8)} />
      <main className="page">{children}</main>
    </>
  )
}
