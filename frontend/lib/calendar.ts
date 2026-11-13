import type { CalendarBooking, CalendarResource, CalendarSpan, DayCalendar, SlotInput } from './types'

const DEFAULT_BOOKING_MINUTES = 120

function durationText(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return [hours ? `${hours} hr` : '', rest ? `${rest} min` : ''].filter(Boolean).join(' ')
}

// Suggests two hours from the chosen slot (or the resource's longest allowed booking if
// shorter). If the next booking, maintenance or closing time comes sooner, the
// suggestion stops there and `note` explains the gap.
export function suggestSlot(
  resource: CalendarResource,
  date: string,
  start: number,
): { slot: SlotInput; note: string } {
  const wanted = Math.min(DEFAULT_BOOKING_MINUTES, resource.maxReservationMinutes ?? DEFAULT_BOOKING_MINUTES)
  const window = resource.windows.find((candidate) => candidate.start <= start && candidate.end > start)

  const limits: Array<{ at: number; reason: string }> = [{ at: window?.end ?? start + 30, reason: 'closes' }]
  const nextBooking = resource.bookings.filter((booking) => booking.start >= start).sort((a, b) => a.start - b.start)[0]
  if (nextBooking) limits.push({ at: nextBooking.start, reason: 'the next booking starts' })
  const nextMaintenance = resource.maintenance.filter((period) => period.start >= start).sort((a, b) => a.start - b.start)[0]
  if (nextMaintenance) limits.push({ at: nextMaintenance.start, reason: 'maintenance starts' })
  const limit = limits.reduce((soonest, candidate) => (candidate.at < soonest.at ? candidate : soonest))

  const end = Math.max(Math.min(start + wanted, limit.at), start + 15)
  const free = limit.at - start
  const note =
    free < wanted
      ? `Only ${durationText(free)} is free here: ${limit.reason === 'closes' ? 'it closes' : limit.reason} at ${clock(limit.at)}.`
      : ''

  return { slot: { date, start: toHHMM(start), end: toHHMM(end) }, note }
}

// One grid cell is half an hour; bookings can be 15 minutes, so a cell that any
// booking touches counts as taken.
export const SLOT_MINUTES = 30

export type CellState = 'open' | 'booked' | 'mine' | 'maintenance' | 'closed' | 'past'

export type Cell = {
  start: number
  end: number
  state: CellState
  booking: CalendarBooking | null
  note: string
}

// 570 -> "9:30 AM", 1440 -> "12:00 AM"
export function clock(minutes: number): string {
  const hours = Math.floor(minutes / 60) % 24
  const rest = minutes % 60
  const suffix = hours >= 12 ? 'PM' : 'AM'
  return `${hours % 12 || 12}:${String(rest).padStart(2, '0')} ${suffix}`
}

// 570 -> "09:30" (the API's HH:MM format)
export function toHHMM(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

export function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  return shifted.toISOString().slice(0, 10)
}

export function longDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

const overlaps = (span: CalendarSpan, start: number, end: number) => span.start < end && span.end > start

// The hours worth showing: from the earliest opening to the latest closing among the
// listed resources, padded to whole hours. Falls back to a daytime range.
export function visibleRange(resources: CalendarResource[]): { from: number; to: number } {
  const spans = resources.flatMap((resource) => [...resource.windows, ...resource.bookings])
  if (spans.length === 0) return { from: 8 * 60, to: 20 * 60 }

  const from = Math.floor(Math.min(...spans.map((span) => span.start)) / 60) * 60
  const to = Math.ceil(Math.max(...spans.map((span) => span.end)) / 60) * 60
  // Keep at least four hours so a short window doesn't render a sliver.
  return { from, to: Math.max(to, Math.min(1440, from + 4 * 60)) }
}

export function buildCells(resource: CalendarResource, calendar: DayCalendar, from: number, to: number): Cell[] {
  const cells: Cell[] = []

  for (let start = from; start < to; start += SLOT_MINUTES) {
    const end = start + SLOT_MINUTES
    const booking = resource.bookings.find((candidate) => overlaps(candidate, start, end)) ?? null
    const maintenance = resource.maintenance.find((candidate) => overlaps(candidate, start, end))
    const inWindow = resource.windows.some((window) => window.start <= start && window.end >= end)
    const isPast = calendar.date < calendar.today || (calendar.date === calendar.today && end <= calendar.nowMinutes)

    let state: CellState
    let note: string

    if (booking) {
      state = booking.mine ? 'mine' : 'booked'
      note = booking.mine ? 'Your reservation' : 'Booked'
    } else if (maintenance) {
      state = 'maintenance'
      note = `Maintenance: ${maintenance.reason}`
    } else if (!inWindow) {
      state = 'closed'
      note = 'Not available'
    } else if (isPast) {
      state = 'past'
      note = 'Already passed'
    } else {
      state = 'open'
      note = 'Available'
    }

    cells.push({ start, end, state, booking, note })
  }

  return cells
}
