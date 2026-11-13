import type { ReservationOutcome } from './types'

export type BarItem = { key: string | number; label: string; value: number; detail?: string }

export type OutcomeStyle = { id: ReservationOutcome; label: string; description: string; color: string }

// One order, label, and color per outcome, shared by every chart and legend.
export const OUTCOMES: OutcomeStyle[] = [
  { id: 'upcoming', label: 'Upcoming', description: 'Confirmed and not started yet', color: '#2f8f6a' },
  { id: 'in_progress', label: 'In progress', description: 'Confirmed and happening now', color: '#d99a2b' },
  { id: 'completed', label: 'Completed', description: 'Recorded as completed', color: '#630031' },
  { id: 'past', label: 'Past', description: 'Confirmed; the booked time has ended (attendance not recorded)', color: '#c58aa5' },
  { id: 'no_show', label: 'No-show', description: 'Recorded as a no-show', color: '#5f6b7a' },
  { id: 'cancelled', label: 'Cancelled', description: 'Cancelled before it started', color: '#c84b4b' },
  { id: 'other', label: 'Other status', description: 'A status CampusConnect does not recognize', color: '#c9ced6' },
]

// "2026-10" -> "Oct 2026"
export function formatMonth(month: string, style: 'short' | 'long' = 'short'): string {
  const [year, monthIndex] = month.split('-').map(Number)
  return new Date(year, monthIndex - 1, 1).toLocaleDateString(undefined, {
    month: style,
    year: 'numeric',
  })
}

export function formatHours(hours: number): string {
  // 4 -> "4 hr", 10.5 -> "10.5 hr", 6.25 -> "6.25 hr"
  return `${Number(hours.toFixed(2))} hr`
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}
