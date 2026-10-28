// API timestamps have no time zone suffix, so the browser parses them as local
// wall-clock time, which is the campus time they were stored in.

export function formatDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function formatDate(value: string): string {
  return new Date(value.length === 10 ? `${value}T00:00:00` : value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

// "18:30" -> "6:30 PM"
export function formatClock(value: string): string {
  const [hours, minutes] = value.split(':').map(Number)
  const suffix = hours >= 12 ? 'PM' : 'AM'
  return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${suffix}`
}

export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours && rest) return `${hours} hr ${rest} min`
  return hours ? `${hours} hr` : `${rest} min`
}

export function formatRating(average: number | null, count: number): string {
  if (average === null || count === 0) return 'No reviews yet'
  return `${average.toFixed(1)} (${count} review${count === 1 ? '' : 's'})`
}
