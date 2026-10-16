<script lang="ts">
  import { onDestroy } from 'svelte'
  import { getJson, isAbortError, sendForm, sendJson } from '../../lib/api'
  import { formatClock, formatDate, formatDateTime, formatDuration, formatRating } from '../../lib/format'
  import type { ListingDetails, ListingFormOptions, PublicUser, ResourceFilterOptions } from '../../lib/types'
  import ResourceForm from '../resources/ResourceForm.svelte'

  export let listingId: string
  export let user: PublicUser

  let listing: ListingDetails | null = null
  let options: ListingFormOptions | null = null
  let loading = true
  let error = ''
  let optionsError = ''
  let editing = false
  let deleting = false
  let deleteSubmitting = false
  let deleteError = ''
  let controller: AbortController | undefined
  let image: ListingDetails['images'][number] | undefined

  $: void load(listingId)
  $: image = listing?.images[0]

  async function load(id: string) {
    controller?.abort()
    const request = new AbortController()
    controller = request
    loading = true
    error = ''
    try {
      const payload = await getJson<{ listing: ListingDetails }>(`/api/listings/${encodeURIComponent(id)}`, request.signal)
      listing = payload.listing
    } catch (caught) {
      if (isAbortError(caught)) return
      listing = null
      error = caught instanceof Error ? caught.message : 'Unable to load this listing.'
    } finally {
      if (controller === request) loading = false
    }
  }

  async function loadOptions() {
    try {
      const payload = await getJson<ResourceFilterOptions>('/api/resources/filters')
      options = { categories: payload.categories, buildings: payload.buildings }
    } catch (caught) {
      optionsError = caught instanceof Error ? caught.message : 'Unable to load building and category options.'
    }
  }

  async function save(body: FormData, onProgress: (loaded: number, total: number) => void) {
    const payload = await sendForm<{ listing: ListingDetails }>('PATCH', `/api/listings/${encodeURIComponent(listingId)}`, body, onProgress)
    listing = payload.listing
    editing = false
  }

  async function confirmDelete() {
    if (!listing || deleteSubmitting) return
    deleteSubmitting = true
    deleteError = ''
    try {
      await sendJson('DELETE', `/api/listings/${encodeURIComponent(listing.id)}`)
      window.location.hash = '#/listings'
    } catch (caught) {
      deleteError = caught instanceof Error ? caught.message : 'Unable to delete this listing.'
    } finally {
      deleteSubmitting = false
    }
  }

  function closeDelete() {
    if (!deleteSubmitting) {
      deleting = false
      deleteError = ''
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && deleting) closeDelete()
  }

  $: if (listingId) void loadOptions()
  onDestroy(() => controller?.abort())
</script>

<svelte:window on:keydown={handleKeydown} />

<section class="resource-detail listing-detail">
  <a class="back-link" href="#/listings">
    <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 6.5 9 12l5.5 5.5" /></svg>
    Back to my listings
  </a>

  {#if loading && !listing}
    <div class="panel" aria-live="polite"><p class="muted">Loading listing…</p></div>
  {:else if error}
    <div class="notice error-notice state-notice" role="alert">
      <p>{error}</p>
      <button type="button" class="secondary-button" on:click={() => load(listingId)}>Try again</button>
    </div>
  {:else if listing}
    {#if listing.hasActiveReservation}
      <p class="notice active-listing-notice" role="status">
        Editing and deletion are unavailable while a reservation is in progress
        ({formatDateTime(listing.activeReservation!.startTime)} – {formatClock(listing.activeReservation!.endTime.slice(11, 16))}).
      </p>
    {/if}
    {#if optionsError}<p class="notice error-notice" role="alert">{optionsError}</p>{/if}

    <article class="panel detail-card">
      <div class="detail-hero">
        {#if image?.url}
          <img class="detail-image" src={image.url} alt={image.altText ?? ''} />
        {:else}
          <div class="detail-image resource-thumb-placeholder" aria-hidden="true">
            <svg class="nav-icon" viewBox="0 0 24 24"><path d="M4 20V8l8-4 8 4v12" /><path d="M9 20v-6h6v6" /></svg>
          </div>
        {/if}

        <div class="detail-summary">
          <div class="listing-card-badges"><span class="badge">{listing.category.name}</span></div>
          <h2>{listing.name}</h2>
          <p class="muted">{listing.building.name} · {listing.locationDescription}</p>
          <p class="muted detail-address">{listing.building.address}</p>
          <p class="resource-card-rating">{formatRating(listing.averageRating, listing.reviewCount)}</p>
          <div class="detail-actions">
            <button type="button" class="secondary-button" disabled={listing.hasActiveReservation || !options} on:click={() => editing = true}>⚙ Edit</button>
            <button type="button" class="danger-button" disabled={listing.hasActiveReservation} on:click={() => deleting = true}>Delete</button>
          </div>
        </div>
      </div>

      <div class="detail-info-grid">
        <section class="detail-block detail-block-wide">
          <h3>Description</h3>
          <div class="detail-subsections">
            <div>
              <h4>Resource description</h4>
              <p class="detail-description">{listing.description}</p>
            </div>
            <div>
              <h4>Location description</h4>
              <p class="detail-description">{listing.locationDescription}</p>
            </div>
          </div>
        </section>

        <section class="detail-block">
          <h3>Location</h3>
          <dl class="profile-details detail-facts">
            <div><dt>Building</dt><dd>{listing.building.name}</dd></div>
            <div><dt>Address</dt><dd>{listing.building.address}</dd></div>
            <div><dt>Building coordinates</dt><dd>{listing.building.latitude}, {listing.building.longitude}</dd></div>
          </dl>
        </section>

        <section class="detail-block">
          <h3>Reservation facts</h3>
          <dl class="profile-details detail-facts">
            <div><dt>Capacity</dt><dd>{listing.capacity} {listing.capacity === 1 ? 'person' : 'people'}</dd></div>
            <div><dt>Credits per booking</dt><dd>{listing.requiredCredits}</dd></div>
            <div><dt>Longest booking</dt><dd>{listing.maxReservationMinutes ? formatDuration(listing.maxReservationMinutes) : 'No limit'}</dd></div>
            <div><dt>Listed by</dt><dd>{user.username}</dd></div>
          </dl>
        </section>

        <section class="detail-block detail-block-wide">
          <h3>Availability schedule</h3>
          <ul class="maintenance-list">
            {#each listing.availability as slot (slot.id)}
              <li>
                <strong>{formatDateTime(slot.startTime)} – {formatDateTime(slot.endTime)}</strong>
                <span class="muted">
                  {#if slot.repeat === 'none'}Does not repeat{:else}{slot.repeat.replaceAll('_', ' ')} until {formatDateTime(slot.repeatsUntil!)}{/if}
                </span>
              </li>
            {/each}
          </ul>
        </section>
      </div>

      <div class="detail-columns">
        <section class="detail-block">
          <h3>Features</h3>
          {#if listing.features.length === 0}<p class="muted">No features listed.</p>{:else}<ul class="feature-details">{#each listing.features as feature}<li><strong>{feature.name}</strong><span class="muted">{feature.description}</span></li>{/each}</ul>{/if}
        </section>
        <section class="detail-block">
          <h3>Hours this week</h3>
          <table class="hours-table"><tbody>{#each listing.weeklyHours as day (day.date)}<tr><th scope="row">{day.weekday} <span class="muted">{formatDate(day.date)}</span></th><td>{day.windows.length ? day.windows.map((slot) => slot.allDay ? 'Open all day' : `${formatClock(slot.opensAt)} – ${formatClock(slot.closesAt)}`).join(', ') : 'Closed'}</td></tr>{/each}</tbody></table>
        </section>
      </div>

      <div class="detail-columns detail-secondary-grid">
        <section class="detail-block">
          <h3>Upcoming maintenance</h3>
          {#if listing.upcomingMaintenance.length === 0}<p class="muted">No maintenance scheduled.</p>{:else}<ul class="maintenance-list">{#each listing.upcomingMaintenance as period}<li><strong>{formatDateTime(period.startTime)} – {formatDateTime(period.endTime)}</strong><span class="muted">{period.reason}</span></li>{/each}</ul>{/if}
        </section>

        <section class="detail-block">
          <h3>Recent reviews</h3>
          {#if listing.recentReviews.length === 0}<p class="muted">No reviews yet.</p>{:else}<ul class="review-list">{#each listing.recentReviews as review}<li class="review"><p class="review-heading"><span class="star">{'★'.repeat(review.rating)}{'☆'.repeat(Math.max(0, 5 - review.rating))}</span><span class="muted">{review.reviewerUsername ?? 'Anonymous'} · {formatDate(review.createdAt)}</span></p>{#if review.reason}<p>{review.reason}</p>{/if}</li>{/each}</ul>{/if}
        </section>
      </div>
    </article>
  {/if}
</section>

{#if editing && listing && options}
  <ResourceForm title="Edit resource" submitLabel="Save changes" initial={listing} {options} onSubmit={save} onClose={() => editing = false} />
{/if}

{#if deleting && listing}
  <div class="modal-layer">
    <button type="button" class="modal-backdrop" aria-label="Keep listing" on:click={closeDelete}></button>
    <dialog open class="modal" aria-labelledby="delete-listing-title" role="alertdialog">
      <div class="modal-heading"><div><p class="eyebrow">Delete listing</p><h2 id="delete-listing-title">Delete {listing.name}?</h2></div><button type="button" class="modal-close" aria-label="Keep listing" on:click={closeDelete}>×</button></div>
      <p>This permanently removes the listing, its image, and its reservation history.</p>
      {#if deleteError}<p class="notice error-notice form-error" role="alert">{deleteError}</p>{/if}
      <div class="form-actions"><button type="button" class="secondary-button" on:click={closeDelete} disabled={deleteSubmitting}>Keep listing</button><button type="button" class="danger-button" on:click={confirmDelete} disabled={deleteSubmitting}>{deleteSubmitting ? 'Deleting…' : 'Delete permanently'}</button></div>
    </dialog>
  </div>
{/if}
