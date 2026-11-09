import Link from 'next/link'
import { QUEUE_FILTERS } from 'modqueue'
import type { QueueFilter, QueueItem } from 'modqueue'
import { readQueue, requireRole } from '@/lib/kit'
import { UUID_RE, parseFilter, strikeOptions } from '@/lib/queue'
import { Queue } from '@/components/queue'

type Search = Promise<{ filter?: string; owner?: string; case?: string }>

const FILTER_LABEL: Record<QueueFilter, string> = {
  open: 'Open',
  claimed: 'Claimed',
  mine: 'Mine',
  decided: 'Decided',
}

function href(filter: QueueFilter, ownerId: string | null): string {
  const q = new URLSearchParams({ filter })
  if (ownerId) q.set('owner', ownerId)
  return `/admin/moderation?${q.toString()}`
}

export default async function ModerationQueuePage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams
  const { principal, store } = await requireRole('moderator')
  const ownerId = principal.role === 'admin' && UUID_RE.test(params.owner ?? '') ? (params.owner as string) : null
  const caseId = UUID_RE.test(params.case ?? '') ? (params.case as string) : null

  let filter = parseFilter(params.filter)
  let items: QueueItem[] = await readQueue(store, principal, filter, ownerId)

  // A deep link to a case that is not in the chosen filter falls back to the filter that holds it.
  let caseFound = caseId ? items.some((i) => i.caseId === caseId) : true
  if (caseId && !caseFound) {
    for (const other of QUEUE_FILTERS.filter((f) => f !== filter)) {
      const found: QueueItem[] = await readQueue(store, principal, other, ownerId)
      if (found.some((i) => i.caseId === caseId)) {
        filter = other
        items = found
        caseFound = true
        break
      }
    }
  }

  return (
    <>
      <h1>Moderation queue</h1>
      <p className="muted small">{items.length} {items.length === 1 ? 'case' : 'cases'} in this view</p>
      <nav className="chips" aria-label="Queue views">
        {QUEUE_FILTERS.map((f) => (
          <Link key={f} href={href(f, ownerId)} className={f === filter ? 'chip active' : 'chip'} aria-current={f === filter ? 'page' : undefined}>
            {FILTER_LABEL[f]}
          </Link>
        ))}
      </nav>
      {ownerId && (
        <p className="alert warn small">
          Showing cases for one member only. <Link href={href(filter, null)}>Clear</Link>
        </p>
      )}
      {caseId && !caseFound && (
        <p className="alert warn" role="status">That case is not in the queue.</p>
      )}
      <Queue
        items={items}
        filter={filter}
        role={principal.role}
        userId={principal.userId}
        openCaseId={caseFound ? caseId : null}
        strikeOptions={strikeOptions()}
      />
    </>
  )
}
