<script lang="ts">
  import { onDestroy } from 'svelte'
  import { getJson, isAbortError } from '../../lib/api'
  import { formatClock, formatDate, formatDateTime, formatDuration, formatRating } from '../../lib/format'
  import type { ResourceDetails } from '../../lib/types'

  export let resourceId: string
  // The results page's filter query, kept so "Back to results" restores it.
  export let backQuery: string

  let resource: ResourceDetails | null = null
  let loading = true
  let error = ''
  let controller: AbortController | undefined

  $: backHref = `#/resources${backQuery ? `?${backQuery}` : ''}`
  $: image = resource?.images[0] ?? null
  $: void load(resourceId)

  async function load(id: string) {
    controller?.abort()
    const request = new AbortController()
    controller = request
    loading = true
    error = ''

    try {
      const payload = await getJson<{ resource: ResourceDetails }>(
        `/api/resources/${encodeURIComponent(id)}`,
        request.signal,
      )
      resource = payload.resource
    } catch (caught) {
      if (isAbortError(caught)) return
      resource = null
      error = caught instanceof Error ? caught.message : 'Unable to load this resource.'
    } finally {
      if (controller === request) loading = false
    }
  }

  onDestroy(() => controller?.abort())
</script>

<section class="resource-detail">
  <a class="back-link" href={backHref}>
    <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 6.5 9 12l5.5 5.5" /></svg>
    Back to results
  </a>

  {#if loading && !resource}
    <div class="panel" aria-live="polite"><p class="muted">Loading resource…</p></div>
  {:else if error}
    <div class="notice error-notice state-notice" role="alert">
      <p>{error}</p>
      <button type="button" class="secondary-button" on:click={() => load(resourceId)}>Try again</button>
    </div>
  {:else if resource}
    <article class="panel detail-card">
      <div class="detail-hero">
        {#if image?.url}
          <img class="detail-image" src={image.url} alt={image.altText ?? ''} />
        {:else}
          <div class="detail-image resource-thumb-placeholder" aria-hidden="true">
            <svg class="nav-icon" viewBox="0 0 24 24">
              <path d="M4 20V8l8-4 8 4v12" />
              <path d="M9 20v-6h6v6" />
            </svg>
          </div>
        {/if}

        <div class="detail-summary">
          <span class="badge">{resource.category.name}</span>
          <h2>{resource.name}</h2>
          <p class="muted">{resource.building.name} · {resource.locationDescription}</p>
          <p class="muted detail-address">{resource.building.address}</p>
          <p class="resource-card-rating">
            {#if resource.averageRating !== null}<span class="star" aria-hidden="true">★</span>{/if}
            {formatRating(resource.averageRating, resource.reviewCount)}
          </p>

          <div class="reserve-box">
            <button type="button" disabled aria-describedby="reserve-note">Reserve</button>
            <p id="reserve-note" class="muted">Reservations coming soon</p>
          </div>
        </div>
      </div>

      <p class="detail-description">{resource.description}</p>

      <dl class="profile-details detail-facts">
        <div><dt>Capacity</dt><dd>{resource.capacity} {resource.capacity === 1 ? 'person' : 'people'}</dd></div>
        <div><dt>Credits per booking</dt><dd>{resource.requiredCredits}</dd></div>
        <div>
          <dt>Longest booking</dt>
          <dd>{resource.maxReservationMinutes ? formatDuration(resource.maxReservationMinutes) : 'No limit'}</dd>
        </div>
        <div><dt>Listed by</dt><dd>{resource.ownerUsername}</dd></div>
      </dl>

      <div class="detail-columns">
        <section class="detail-block">
          <h3>Features</h3>
          {#if resource.features.length === 0}
            <p class="muted">No features listed.</p>
          {:else}
            <ul class="feature-details">
              {#each resource.features as feature, index (index)}
                <li><strong>{feature.name}</strong><span class="muted">{feature.description}</span></li>
              {/each}
            </ul>
          {/if}
        </section>

        <section class="detail-block">
          <h3>Hours this week</h3>
          <table class="hours-table">
            <tbody>
              {#each resource.weeklyHours as day (day.date)}
                <tr>
                  <th scope="row">{day.weekday} <span class="muted">{formatDate(day.date)}</span></th>
                  <td>
                    {#if day.windows.length === 0}
                      <span class="muted">Closed</span>
                    {:else}
                      {day.windows.map((slot) => `${formatClock(slot.opensAt)} – ${formatClock(slot.closesAt)}`).join(', ')}
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </section>
      </div>

      <section class="detail-block">
        <h3>Upcoming maintenance</h3>
        {#if resource.upcomingMaintenance.length === 0}
          <p class="muted">No maintenance scheduled.</p>
        {:else}
          <ul class="maintenance-list">
            {#each resource.upcomingMaintenance as period (period.id)}
              <li>
                <strong>{formatDateTime(period.startTime)} – {formatDateTime(period.endTime)}</strong>
                <span class="muted">{period.reason}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <section class="detail-block">
        <h3>Recent reviews</h3>
        {#if resource.recentReviews.length === 0}
          <p class="muted">No reviews yet.</p>
        {:else}
          <ul class="review-list">
            {#each resource.recentReviews as review (review.id)}
              <li class="review">
                <p class="review-heading">
                  <span class="star" aria-label={`${review.rating} out of 5 stars`}>
                    {'★'.repeat(review.rating)}{'☆'.repeat(Math.max(0, 5 - review.rating))}
                  </span>
                  <span class="muted">{review.reviewerUsername ?? 'Anonymous'} · {formatDate(review.createdAt)}</span>
                </p>
                {#if review.reason}<p>{review.reason}</p>{/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    </article>
  {/if}
</section>
