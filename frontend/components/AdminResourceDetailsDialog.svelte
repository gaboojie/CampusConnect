<script lang="ts">
  import { onMount } from 'svelte'
  import { getJson } from '../lib/api'
  import { adminHash } from '../lib/adminRoutes'
  import { formatDateTime, formatDuration, formatRating } from '../lib/format'
  import type { AdminResourceDetail } from '../lib/types'

  export let resourceId: number
  export let onClose: () => void
  export let onDelete: (resource: AdminResourceDetail) => void

  let resource: AdminResourceDetail | null = null
  let loading = true
  let error = ''

  onMount(async () => {
    try {
      resource = (await getJson<{ resource: AdminResourceDetail }>(`/api/admin/resources/${resourceId}`)).resource
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Unable to load this resource.'
    } finally {
      loading = false
    }
  })

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') onClose()
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="modal-layer">
  <button type="button" class="modal-backdrop" aria-label="Close details" on:click={onClose}></button>
  <dialog open class="modal resource-admin-modal" aria-labelledby="resource-details-title">
    <div class="modal-heading">
      <div>
        <p class="eyebrow">Resource #{resourceId}</p>
        <h2 id="resource-details-title">{resource?.name ?? 'Resource details'}</h2>
        {#if resource}
          <p class="muted">{resource.category.name} · {resource.building.name}</p>
        {/if}
      </div>
      <button type="button" class="modal-close" aria-label="Close details" on:click={onClose}>×</button>
    </div>

    {#if loading}
      <p class="muted">Loading details…</p>
    {:else if error}
      <p class="notice error-notice" role="alert">{error}</p>
    {:else if resource}
      {#if resource.images[0]?.url}
        <img class="resource-admin-image" src={resource.images[0].url} alt={resource.images[0].altText ?? resource.name} />
      {/if}

      <p>{resource.description}</p>

      <dl class="profile-details">
        <div><dt>Location</dt><dd>{resource.locationDescription}</dd></div>
        <div><dt>Address</dt><dd>{resource.building.address}</dd></div>
        <div>
          <dt>Owner</dt>
          <dd><a href={`${adminHash('users')}/${resource.owner.id}`} on:click={onClose}>{resource.owner.username}</a></dd>
        </div>
        <div><dt>Listed</dt><dd>{formatDateTime(resource.createdAt)}</dd></div>
        <div><dt>Capacity</dt><dd>{resource.capacity}</dd></div>
        <div><dt>Credits per booking</dt><dd>{resource.requiredCredits}</dd></div>
        <div>
          <dt>Longest booking</dt>
          <dd>{resource.maxReservationMinutes === null ? 'No limit' : formatDuration(resource.maxReservationMinutes)}</dd>
        </div>
        <div><dt>Rating</dt><dd>{formatRating(resource.averageRating, resource.reviewCount)}</dd></div>
        <div><dt>Upcoming reservations</dt><dd>{resource.upcomingReservations}</dd></div>
        <div>
          <dt>All reservations</dt>
          <dd>
            {#each Object.entries(resource.reservationCounts) as [status, count]}
              <span class={`badge status-${status}`}>{status}: {count}</span>{' '}
            {:else}
              None
            {/each}
          </dd>
        </div>
      </dl>

      {#if resource.features.length > 0}
        <div>
          <h3>Features</h3>
          <p>
            {#each resource.features as feature}
              <span class="badge" title={feature.description}>{feature.name}</span>{' '}
            {/each}
          </p>
        </div>
      {/if}

      {#if resource.upcomingMaintenance.length > 0}
        <div>
          <h3>Upcoming maintenance</h3>
          <ul>
            {#each resource.upcomingMaintenance as period}
              <li>{formatDateTime(period.startTime)} – {formatDateTime(period.endTime)}: {period.reason}</li>
            {/each}
          </ul>
        </div>
      {/if}
    {/if}

    <div class="password-actions">
      {#if resource}
        <button type="button" class="danger-button" on:click={() => resource && onDelete(resource)}>Delete resource</button>
      {/if}
      <button type="button" class="secondary-button" on:click={onClose}>Close</button>
    </div>
  </dialog>
</div>
