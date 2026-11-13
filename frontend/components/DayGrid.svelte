<script lang="ts">
  import { SLOT_MINUTES, buildCells, clock, visibleRange } from '../lib/calendar'
  import type { CalendarBooking, CalendarResource, DayCalendar } from '../lib/types'

  export let calendar: DayCalendar
  // Called when an open (available) cell is chosen. Leave unset for a read-only grid.
  export let onPickSlot: ((resource: CalendarResource, start: number) => void) | undefined = undefined
  // Called when a booking the viewer may open is chosen (any booking for admins, otherwise their own).
  export let onPickBooking: ((resource: CalendarResource, booking: CalendarBooking) => void) | undefined = undefined

  $: range = visibleRange(calendar.resources)
  $: columns = Math.max(1, (range.to - range.from) / SLOT_MINUTES)
  $: hours = Array.from({ length: Math.ceil((range.to - range.from) / 60) }, (_, index) => range.from + index * 60)
  $: rows = calendar.resources.map((resource) => ({
    resource,
    cells: buildCells(resource, calendar, range.from, range.to),
  }))

  function hourLabel(minutes: number): string {
    return clock(minutes).replace(':00 ', ' ')
  }

  function title(
    resource: CalendarResource,
    cell: { start: number; end: number; note: string; booking: CalendarBooking | null },
  ): string {
    const who = cell.booking?.username ? ` by ${cell.booking.username}` : ''
    return `${resource.name}, ${clock(cell.start)} – ${clock(cell.end)}: ${cell.note}${who}`
  }
</script>

<div class="cal-scroll">
  <div class="cal-grid" style={`--cols:${columns}`} role="table" aria-label="Resource availability">
    <div class="cal-corner" role="columnheader">Resource</div>
    <div class="cal-hours" role="row">
      {#each hours as hour}
        <span class="cal-hour" style={`grid-column: span ${60 / SLOT_MINUTES}`} role="columnheader">{hourLabel(hour)}</span>
      {/each}
    </div>

    {#each rows as { resource, cells } (resource.id)}
      <div class="cal-name" role="rowheader">
        <strong>{resource.name}</strong>
        <span>{resource.building.name} · {resource.capacity} {resource.capacity === 1 ? 'person' : 'people'} · {resource.requiredCredits} cr</span>
      </div>
      <div class="cal-row" role="row">
        {#each cells as cell (cell.start)}
          {#if cell.state === 'open' && onPickSlot}
            <button
              type="button"
              class="cal-cell cal-open"
              title={title(resource, cell)}
              aria-label={title(resource, cell)}
              on:click={() => onPickSlot?.(resource, cell.start)}
            ></button>
          {:else if cell.booking && onPickBooking && (cell.booking.id !== null || cell.booking.mine)}
            <button
              type="button"
              class={`cal-cell cal-${cell.state} cal-action`}
              title={title(resource, cell)}
              aria-label={title(resource, cell)}
              on:click={() => cell.booking && onPickBooking?.(resource, cell.booking)}
            ></button>
          {:else}
            <div class={`cal-cell cal-${cell.state}`} title={title(resource, cell)} role="cell"></div>
          {/if}
        {/each}
      </div>
    {/each}
  </div>
</div>

<ul class="cal-legend" aria-label="Legend">
  <li><i class="cal-open"></i>Available</li>
  <li><i class="cal-booked"></i>Booked</li>
  <li><i class="cal-mine"></i>Your reservation</li>
  <li><i class="cal-maintenance"></i>Maintenance</li>
  <li><i class="cal-closed"></i>Not available</li>
</ul>
