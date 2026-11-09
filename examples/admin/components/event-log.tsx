import type { EventRow } from 'modqueue'
import { timeAgo } from '@/lib/format'

export function EventLog({ events }: { events: EventRow[] }) {
  if (events.length === 0) return <p className="muted small">No events yet.</p>
  return (
    <ul className="events" data-testid="event-log">
      {events.map((evt) => (
        <li key={evt.id} data-event-type={evt.eventType}>
          <span className={`badge ${evt.severity}`}>{evt.eventType.replace(/_/g, ' ')}</span>{' '}
          <span className="muted">{evt.source}, {timeAgo(evt.createdAt)}</span>
          {evt.summary && <div>{evt.summary}</div>}
        </li>
      ))}
    </ul>
  )
}
