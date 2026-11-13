<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { getJson, isAbortError } from '../lib/api'
  import { longDate, shiftDate } from '../lib/calendar'
  import type { CalendarBooking, CalendarResource, DayCalendar, ResourceFilterOptions } from '../lib/types'
  import DayGrid from './DayGrid.svelte'

  export let onPickSlot: ((resource: CalendarResource, start: number, date: string) => void) | undefined = undefined
  export let onPickBooking: ((resource: CalendarResource, booking: CalendarBooking, date: string) => void) | undefined = undefined
  // Show only this resource and hide the search and filters.
  export let resourceId: number | null = null

  const SEARCH_DEBOUNCE_MS = 350

  // An empty date means "today"; the server answers with the campus date.
  let date = ''
  let search = ''
  let category = ''
  let building = ''
  let filters: ResourceFilterOptions | null = null
  let calendar: DayCalendar | null = null
  let loading = true
  let error = ''
  let controller: AbortController | undefined
  let searchTimer: ReturnType<typeof setTimeout> | undefined

  export async function reload() {
    controller?.abort()
    const request = new AbortController()
    controller = request
    loading = true
    error = ''

    const params = new URLSearchParams()
    if (date) params.set('date', date)
    if (search.trim()) params.set('search', search.trim())
    if (category) params.set('category', category)
    if (building) params.set('building', building)
    if (resourceId !== null) params.set('resource', String(resourceId))

    try {
      const next = await getJson<DayCalendar>(`/api/calendar?${params}`, request.signal)
      calendar = next
      date = next.date
    } catch (caught) {
      if (isAbortError(caught)) return
      calendar = null
      error = caught instanceof Error ? caught.message : 'Unable to load the calendar.'
    } finally {
      if (controller === request) loading = false
    }
  }

  function goToDate(next: string) {
    if (!next) return
    date = next
    void reload()
  }

  function searchChanged() {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => void reload(), SEARCH_DEBOUNCE_MS)
  }

  onMount(() => {
    void reload()
    if (resourceId === null) getJson<ResourceFilterOptions>('/api/resources/filters')
      .then((options) => (filters = options))
      .catch(() => {
        // The filters are optional; the calendar still works without them.
      })
  })
  onDestroy(() => {
    controller?.abort()
    clearTimeout(searchTimer)
  })
</script>

<div class="cal-toolbar">
  <div class="cal-date-nav" role="group" aria-label="Choose a day">
    <button type="button" class="secondary-button" aria-label="Previous day" disabled={!date} on:click={() => goToDate(shiftDate(date, -1))}>‹</button>
    <input type="date" aria-label="Date" value={date} on:change={(event) => goToDate(event.currentTarget.value)} />
    <button type="button" class="secondary-button" aria-label="Next day" disabled={!date} on:click={() => goToDate(shiftDate(date, 1))}>›</button>
    <button type="button" class="secondary-button" disabled={!calendar || date === calendar.today} on:click={() => goToDate(calendar?.today ?? '')}>Today</button>
  </div>

  {#if resourceId === null}
    <label>
      Search
      <input type="search" placeholder="Resource or building" bind:value={search} on:input={searchChanged} />
    </label>
    <label>
      Type
      <select bind:value={category} on:change={() => void reload()}>
        <option value="">All types</option>
        {#each filters?.categories ?? [] as option (option.id)}
          <option value={String(option.id)}>{option.name}</option>
        {/each}
      </select>
    </label>
    <label>
      Building
      <select bind:value={building} on:change={() => void reload()}>
        <option value="">All buildings</option>
        {#each filters?.buildings ?? [] as option (option.id)}
          <option value={String(option.id)}>{option.name}</option>
        {/each}
      </select>
    </label>
  {/if}
</div>

{#if calendar}
  <h3 class="cal-title">{longDate(calendar.date)}{#if calendar.date === calendar.today} <span class="badge">Today</span>{/if}</h3>
{/if}

{#if error}
  <p class="notice error-notice" role="alert">{error}</p>
{/if}

<div class="panel cal-panel" aria-busy={loading}>
  {#if loading && !calendar}
    <p class="muted">Loading availability…</p>
  {:else if calendar && calendar.resources.length === 0}
    <p class="muted">No resources match these filters.</p>
  {:else if calendar}
    <DayGrid
      {calendar}
      onPickSlot={onPickSlot ? (resource, start) => onPickSlot?.(resource, start, calendar?.date ?? date) : undefined}
      onPickBooking={onPickBooking ? (resource, booking) => onPickBooking?.(resource, booking, calendar?.date ?? date) : undefined}
    />
    {#if calendar.total > calendar.resources.length}
      <p class="muted cal-note">Showing {calendar.resources.length} of {calendar.total} resources. Use the filters to narrow the list.</p>
    {/if}
  {/if}
</div>
