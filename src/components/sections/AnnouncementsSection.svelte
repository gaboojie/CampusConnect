<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { getJson, isAbortError } from '../../lib/api'
  import { formatDateTime } from '../../lib/format'
  import type { Announcement, AnnouncementType } from '../../lib/types'

  const TYPE_LABELS: Record<AnnouncementType, string> = {
    maintenance: 'Maintenance',
    new: 'New',
  }
  const FILTERS: Array<{ value: AnnouncementType | ''; label: string }> = [
    { value: '', label: 'All' },
    { value: 'maintenance', label: 'Maintenance' },
    { value: 'new', label: 'New resources' },
  ]
  const EMPTY_MESSAGES: Record<AnnouncementType | '', string> = {
    '': 'There are no announcements right now.',
    maintenance: 'No current or upcoming maintenance.',
    new: 'No resources were added in the last 30 days.',
  }

  let type: AnnouncementType | '' = ''
  let announcements: Announcement[] = []
  let loading = true
  let error = ''
  let controller: AbortController | undefined

  async function load() {
    controller?.abort()
    const request = new AbortController()
    controller = request
    loading = true
    error = ''

    try {
      const params = type ? `?type=${type}` : ''
      const payload = await getJson<{ announcements: Announcement[] }>(`/api/announcements${params}`, request.signal)
      announcements = payload.announcements
    } catch (caught) {
      if (isAbortError(caught)) return
      announcements = []
      error = caught instanceof Error ? caught.message : 'Unable to load announcements.'
    } finally {
      if (controller === request) loading = false
    }
  }

  function selectType(value: AnnouncementType | '') {
    if (value === type) return
    type = value
    void load()
  }

  onMount(load)
  onDestroy(() => controller?.abort())
</script>

<section class="announcements-page">
  <header class="page-heading">
    <p class="eyebrow">Campus updates</p>
    <h2>Announcements</h2>
    <p class="muted">Maintenance notices and newly listed resources.</p>
  </header>

  <div class="segmented" role="group" aria-label="Filter announcements by type">
    {#each FILTERS as filter (filter.value)}
      <button
        type="button"
        class="segment"
        class:active={type === filter.value}
        aria-pressed={type === filter.value}
        on:click={() => selectType(filter.value)}
      >
        {filter.label}
      </button>
    {/each}
  </div>

  {#if loading && announcements.length === 0}
    <div class="panel" aria-live="polite"><p class="muted">Loading announcements…</p></div>
  {:else if error}
    <div class="notice error-notice state-notice" role="alert">
      <p>{error}</p>
      <button type="button" class="secondary-button" on:click={load}>Try again</button>
    </div>
  {:else if announcements.length === 0}
    <div class="panel empty-state">
      <h3>Nothing to announce</h3>
      <p class="muted">{EMPTY_MESSAGES[type]}</p>
    </div>
  {:else}
    <ul class="announcement-list" class:stale={loading}>
      {#each announcements as announcement (announcement.id)}
        <li class="panel announcement-card">
          <div class="announcement-heading">
            <span class="badge" class:badge-new={announcement.type === 'new'}>{TYPE_LABELS[announcement.type]}</span>
            <time class="muted" datetime={announcement.date}>{formatDateTime(announcement.date)}</time>
          </div>
          <h3>{announcement.title}</h3>
          <p>{announcement.message}</p>
          <a class="text-link" href={`#/resources/${announcement.resourceId}`}>View resource</a>
        </li>
      {/each}
    </ul>
  {/if}
</section>
