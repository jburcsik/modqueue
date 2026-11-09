export function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} h ago`
  return `${Math.floor(hrs / 24)} d ago`
}

export function weightSum(reports: { trustWeight: number; state: string }[]): string {
  return reports.filter((r) => r.state === 'open').reduce((sum, r) => sum + r.trustWeight, 0).toFixed(2)
}
