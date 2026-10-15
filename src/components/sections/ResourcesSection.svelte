<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import ResourceCard from '../resources/ResourceCard.svelte'
  import { getJson, isAbortError } from '../../lib/api'
  import { parseLocation } from '../../lib/routes'
  import type { ResourceFilterOptions, ResourceSearchResponse } from '../../lib/types'

  // Filters live in the hash query ("#/resources?category=1&feature=Projector"),
  // so refresh and Back from a detail page restore them.
  export let query: string

  const PAGE_SIZE = 12
  const SEARCH_DEBOUNCE_MS = 350
  const SORTS = [
    { value: 'name', label: 'Name (A–Z)' },
    { value: 'rating', label: 'Highest rated' },
    { value: 'capacity', label: 'Largest capacity' },
  ] as const

  type Sort = (typeof SORTS)[number]['value']

  type Filters = {
    q: string
    category: string
    building: string
    features: string[]
    minCapacity: string
    date: string
    start: string
    end: string
    sort: Sort
    offset: number
  }

  function parseFilters(raw: string): Filters {
    const params = new URLSearchParams(raw)
    const sort = params.get('sort') ?? 'name'
    const offset = Number(params.get('offset') ?? '0')

    return {
      q: params.get('q') ?? '',
      category: params.get('category') ?? '',
      building: params.get('building') ?? '',
      features: params.getAll('feature'),
      minCapacity: params.get('minCapacity') ?? '',
      date: params.get('date') ?? '',
      start: params.get('start') ?? '',
      end: params.get('end') ?? '',
      sort: SORTS.some((option) => option.value === sort) ? (sort as Sort) : 'name',
      offset: Number.isInteger(offset) && offset > 0 ? offset : 0,
    }
  }

  function serializeFilters(value: Filters): string {
    const params = new URLSearchParams()
    if (value.q.trim()) params.set('q', value.q.trim())
    if (value.category) params.set('category', value.category)
    if (value.building) params.set('building', value.building)
    for (const feature of value.features) params.append('feature', feature)
    if (value.minCapacity) params.set('minCapacity', value.minCapacity)
    if (value.date && value.start && value.end) {
      params.set('date', value.date)
      params.set('start', value.start)
      params.set('end', value.end)
    }
    if (value.sort !== 'name') params.set('sort', value.sort)
    if (value.offset > 0) params.set('offset', String(value.offset))
    return params.toString()
  }

  let filters = parseFilters(query)
  let currentQuery = serializeFilters(filters)

  // Inputs that only apply once they are complete or after a pause in typing.
  let searchText = filters.q
  let capacityValue = toCapacity(filters.minCapacity)
  let dateText = filters.date
  let startText = filters.start
  let endText = filters.end

  let options: ResourceFilterOptions | null = null
  let optionsError = ''
  let result: ResourceSearchResponse | null = null
  let loading = true
  let error = ''
  let filtersOpen = false
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined

  const today = new Date().toLocaleDateString('en-CA')

  $: timeError = (() => {
    const filled = [dateText, startText, endText].filter(Boolean).length
    if (filled === 0 || (filled === 3 && endText > startText)) return ''
    if (filled < 3) return 'Choose a date, start time, and end time to check availability.'
    return 'End time must be after the start time.'
  })()

  $: activeFilterCount =
    (filters.q.trim() ? 1 : 0) +
    (filters.category ? 1 : 0) +
    (filters.building ? 1 : 0) +
    filters.features.length +
    (filters.minCapacity ? 1 : 0) +
    (filters.date && filters.start && filters.end ? 1 : 0)

  $: pageStart = result && result.total > 0 ? result.offset + 1 : 0
  $: pageEnd = result ? result.offset + result.resources.length : 0
  $: detailSuffix = currentQuery ? `?${currentQuery}` : ''

  function syncInputs() {
    searchText = filters.q
    capacityValue = toCapacity(filters.minCapacity)
    dateText = filters.date
    startText = filters.start
    endText = filters.end
  }

  // Filter edits replace the current history entry so Back leaves the page
  // instead of stepping through every checkbox click.
  function applyFilters(changes: Partial<Filters>, resetPage = true) {
    filters = { ...filters, ...changes, ...(resetPage ? { offset: 0 } : {}) }
    currentQuery = serializeFilters(filters)
    const hash = `#/resources${currentQuery ? `?${currentQuery}` : ''}`
    if (window.location.hash !== hash) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`)
    }
    void loadResults()
  }

  async function loadResults() {
    controller?.abort()
    const request = new AbortController()
    controller = request
    loading = true
    error = ''

    const params = new URLSearchParams(currentQuery)
    params.set('limit', String(PAGE_SIZE))

    try {
      result = await getJson<ResourceSearchResponse>(`/api/resources?${params}`, request.signal)
    } catch (caught) {
      if (isAbortError(caught)) return
      error = caught instanceof Error ? caught.message : 'Unable to load resources.'
      result = null
    } finally {
      if (controller === request) loading = false
    }
  }

  async function loadOptions() {
    optionsError = ''
    try {
      options = await getJson<ResourceFilterOptions>('/api/resources/filters')
    } catch (caught) {
      optionsError = caught instanceof Error ? caught.message : 'Unable to load filter options.'
    }
  }

  function handleSearchInput() {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => applyFilters({ q: searchText }), SEARCH_DEBOUNCE_MS)
  }

  function submitSearch() {
    clearTimeout(searchTimer)
    if (searchText !== filters.q) applyFilters({ q: searchText })
  }

  function toCapacity(value: string): number | null {
    return /^\d+$/.test(value) ? Number(value) : null
  }

  function handleCapacityChange() {
    if (capacityValue === null || capacityValue === undefined) {
      applyFilters({ minCapacity: '' })
    } else if (Number.isInteger(capacityValue) && capacityValue >= 1 && capacityValue <= 10000) {
      applyFilters({ minCapacity: String(capacityValue) })
    }
  }

  function handleTimeChange() {
    if (timeError) return
    const complete = Boolean(dateText && startText && endText)
    applyFilters(complete
      ? { date: dateText, start: startText, end: endText }
      : { date: '', start: '', end: '' })
  }

  function clearTime() {
    dateText = startText = endText = ''
    applyFilters({ date: '', start: '', end: '' })
  }

  function toggleFeature(feature: string, checked: boolean) {
    const features = checked
      ? [...filters.features, feature]
      : filters.features.filter((candidate) => candidate !== feature)
    applyFilters({ features })
  }

  function clearAll() {
    clearTimeout(searchTimer)
    filters = parseFilters('')
    syncInputs()
    applyFilters({})
  }

  function goToPage(offset: number) {
    applyFilters({ offset }, false)
    document.querySelector('.resources-results')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  // Back/forward or a sidebar click can change the hash while this page stays mounted.
  function handleHashChange() {
    const location = parseLocation(window.location.hash)
    if (location.route.id !== 'resources' || location.subpath) return
    if (location.query === currentQuery) return
    filters = parseFilters(location.query)
    currentQuery = serializeFilters(filters)
    syncInputs()
    void loadResults()
  }

  onMount(() => {
    void loadOptions()
    void loadResults()
  })

  onDestroy(() => {
    clearTimeout(searchTimer)
    controller?.abort()
  })
</script>

<svelte:window on:hashchange={handleHashChange} />

<section class="resources-page">
  <header class="page-heading">
    <p class="eyebrow">Browse</p>
    <h2>Campus resources</h2>
    <p class="muted">Find study rooms, courts, studios, and more. Add a date and time to see only what's open.</p>
  </header>

  <div class="resources-layout">
    <aside class="panel filter-panel" class:open={filtersOpen} aria-label="Resource filters">
      <button
        type="button"
        class="secondary-button filter-toggle"
        aria-expanded={filtersOpen}
        aria-controls="resource-filter-form"
        on:click={() => filtersOpen = !filtersOpen}
      >
        Filters{activeFilterCount ? ` (${activeFilterCount})` : ''}
        <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>
      </button>

      <form id="resource-filter-form" class="filter-form" on:submit|preventDefault={submitSearch}>
        <label>
          Search
          <input
            type="search"
            placeholder="Name or description"
            maxlength="100"
            bind:value={searchText}
            on:input={handleSearchInput}
          />
        </label>

        <label>
          Category
          <select value={filters.category} on:change={(event) => applyFilters({ category: event.currentTarget.value })}>
            <option value="">All categories</option>
            {#each options?.categories ?? [] as category (category.id)}
              <option value={String(category.id)}>{category.name}</option>
            {/each}
          </select>
        </label>

        <label>
          Building
          <select value={filters.building} on:change={(event) => applyFilters({ building: event.currentTarget.value })}>
            <option value="">All buildings</option>
            {#each options?.buildings ?? [] as building (building.id)}
              <option value={String(building.id)}>{building.name}</option>
            {/each}
          </select>
        </label>

        <label>
          Minimum capacity
          <input
            type="number"
            min="1"
            max="10000"
            inputmode="numeric"
            placeholder="Any"
            bind:value={capacityValue}
            on:change={handleCapacityChange}
          />
        </label>

        <fieldset class="filter-fieldset">
          <legend>Available on</legend>
          <label>
            Date
            <input type="date" min={today} bind:value={dateText} on:change={handleTimeChange} />
          </label>
          <div class="time-row">
            <label>
              From
              <input type="time" step="900" bind:value={startText} on:change={handleTimeChange} />
            </label>
            <label>
              To
              <input type="time" step="900" bind:value={endText} on:change={handleTimeChange} />
            </label>
          </div>
          {#if timeError}
            <p class="field-error" role="status">{timeError}</p>
          {/if}
          {#if dateText || startText || endText}
            <button type="button" class="text-button" on:click={clearTime}>Clear date and time</button>
          {/if}
        </fieldset>

        {#if options && options.features.length > 0}
          <fieldset class="filter-fieldset">
            <legend>Features</legend>
            <div class="feature-list">
              {#each options.features as feature (feature)}
                <label class="checkbox-label">
                  <input
                    type="checkbox"
                    checked={filters.features.includes(feature)}
                    on:change={(event) => toggleFeature(feature, event.currentTarget.checked)}
                  />
                  {feature}
                </label>
              {/each}
            </div>
          </fieldset>
        {/if}

        {#if optionsError}
          <p class="field-error">{optionsError}</p>
        {/if}

        {#if activeFilterCount > 0}
          <button type="button" class="secondary-button" on:click={clearAll}>Clear all filters</button>
        {/if}
      </form>
    </aside>

    <div class="resources-results">
      <div class="results-toolbar">
        <p class="muted" aria-live="polite">
          {#if loading && !result}
            Loading resources…
          {:else if result}
            {result.total === 0
              ? 'No matching resources'
              : `Showing ${pageStart}–${pageEnd} of ${result.total} resource${result.total === 1 ? '' : 's'}`}
          {/if}
        </p>
        <label class="sort-label">
          Sort by
          <select value={filters.sort} on:change={(event) => applyFilters({ sort: event.currentTarget.value as Sort })}>
            {#each SORTS as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>
      </div>

      {#if error}
        <div class="notice error-notice state-notice" role="alert">
          <p>{error}</p>
          <button type="button" class="secondary-button" on:click={loadResults}>Try again</button>
        </div>
      {:else if loading && !result}
        <div class="resource-grid" aria-hidden="true">
          {#each Array(6) as _, index (index)}
            <div class="resource-card skeleton-card"></div>
          {/each}
        </div>
      {:else if result && result.resources.length === 0}
        <div class="panel empty-state">
          <h3>No resources found</h3>
          <p class="muted">
            {result.total > 0
              ? 'This page is past the end of the results.'
              : 'Try removing a filter or choosing a different time.'}
          </p>
          {#if result.total > 0}
            <button type="button" class="secondary-button" on:click={() => goToPage(0)}>Back to first page</button>
          {:else if activeFilterCount > 0}
            <button type="button" class="secondary-button" on:click={clearAll}>Clear all filters</button>
          {/if}
        </div>
      {:else if result}
        <div class="resource-grid" class:stale={loading}>
          {#each result.resources as resource (resource.id)}
            <ResourceCard {resource} href={`#/resources/${resource.id}${detailSuffix}`} />
          {/each}
        </div>

        {#if result.total > result.limit}
          <nav class="pagination" aria-label="Results pages">
            <button
              type="button"
              class="secondary-button"
              disabled={loading || result.offset === 0}
              on:click={() => goToPage(Math.max(0, result!.offset - result!.limit))}
            >
              Previous
            </button>
            <span class="muted">
              Page {Math.floor(result.offset / result.limit) + 1} of {Math.ceil(result.total / result.limit)}
            </span>
            <button
              type="button"
              class="secondary-button"
              disabled={loading || pageEnd >= result.total}
              on:click={() => goToPage(result!.offset + result!.limit)}
            >
              Next
            </button>
          </nav>
        {/if}
      {/if}
    </div>
  </div>
</section>
