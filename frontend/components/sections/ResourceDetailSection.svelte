<script lang="ts">
  import { onDestroy } from 'svelte'
  import { getJson, isAbortError, sendForm, sendJson } from '../../lib/api'
  import { formatClock, formatDate, formatDateTime, formatDuration, formatRating } from '../../lib/format'
  import { routeHash } from '../../lib/routes'
  import type {
    CreditSummary,
    ListingDetails,
    ListingFormOptions,
    OwnerUserReview,
    PublicUser,
    ResourceDetails,
    ResourceFilterOptions,
    ResourceReviewWarning,
    ReservationWriteResponse,
    SlotInput,
  } from '../../lib/types'
  import { suggestSlot } from '../../lib/calendar'
  import AvailabilityCalendar from '../AvailabilityCalendar.svelte'
  import ResourceForm from '../resources/ResourceForm.svelte'
  import ReservationForm from '../reservations/ReservationForm.svelte'
  import ReservationReviewForm from '../reservations/ReservationReviewForm.svelte'

  export let resourceId: string
  export let backQuery = ''
  export let origin: 'resources' | 'listings' = 'resources'
  export let user: PublicUser
  export let onUserUpdated: (user: PublicUser) => void
  export let onResourceWarningChange: (warning: ResourceReviewWarning | null) => void

  let resource: ResourceDetails | null = null
  let ownerDetails: ListingDetails | null = null
  let options: ListingFormOptions | null = null
  let loading = true
  let error = ''
  let ownerError = ''
  let optionsError = ''
  let ownerLoading = false
  let controller: AbortController | undefined
  let image: ResourceDetails['images'][number] | null = null
  let editing = false
  let deleting = false
  let deleteSubmitting = false
  let deleteError = ''
  let reservationReviews: OwnerUserReview[] = []
  let reviewsLoading = false
  let reviewsError = ''
  let reviewing: OwnerUserReview | null = null
  let reserving = false
  let pickedSlot: SlotInput | null = null
  let pickedNote = ''

  $: backHref = origin === 'listings' ? '#/listings' : `#/resources${backQuery ? `?${backQuery}` : ''}`
  $: backLabel = origin === 'listings' ? 'Back to my listings' : 'Back to results'
  $: image = resource?.images[0] ?? null
  $: isOwner = resource?.isOwner === true
  $: cost = resource?.requiredCredits ?? 0
  $: affordable = isOwner || user.creditBalance >= cost
  $: reviewEligible = isOwner || resource?.minUserReviewScore === null
    || (resource?.viewerReviewScore !== null && resource?.viewerReviewScore !== undefined
      && resource.viewerReviewScore >= (resource.minUserReviewScore ?? 0))
  $: ownerActive = ownerDetails?.hasActiveReservation === true
  $: canEdit = isOwner && ownerDetails !== null && options !== null && !ownerActive
  $: canDelete = isOwner && ownerDetails !== null && !ownerActive
  $: onResourceWarningChange(
    resource && !isOwner && resource.minUserReviewScore !== null && !reviewEligible
      ? { minUserReviewScore: resource.minUserReviewScore, viewerReviewScore: resource.viewerReviewScore }
      : null,
  )
  $: void load(resourceId)

  async function load(id: string) {
    controller?.abort()
    const request = new AbortController()
    controller = request
    resource = null
    ownerDetails = null
    options = null
    reservationReviews = []
    loading = true
    ownerLoading = false
    error = ''
    ownerError = ''
    optionsError = ''
    reviewsError = ''
    try {
      const payload = await getJson<{ resource: ResourceDetails }>(
        `/api/resources/${encodeURIComponent(id)}`,
        request.signal,
      )
      resource = payload.resource
      void refreshBalance(request.signal)
      if (payload.resource.isOwner) void loadOwnerData(id, request.signal)
    } catch (caught) {
      if (isAbortError(caught)) return
      resource = null
      error = caught instanceof Error ? caught.message : 'Unable to load this resource.'
    } finally {
      if (controller === request) loading = false
    }
  }

  async function loadOwnerData(id: string, signal: AbortSignal) {
    ownerLoading = true
    ownerError = ''
    try {
      const payload = await getJson<{ listing: ListingDetails }>(
        `/api/listings/${encodeURIComponent(id)}`,
        signal,
      )
      ownerDetails = payload.listing
      void loadOptions()
      void loadReservationReviews(id, signal)
    } catch (caught) {
      if (isAbortError(caught)) return
      ownerDetails = null
      ownerError = caught instanceof Error ? caught.message : 'Unable to load owner controls.'
    } finally {
      if (!signal.aborted) ownerLoading = false
    }
  }

  async function loadReservationReviews(id: string, signal: AbortSignal) {
    reviewsLoading = true
    reviewsError = ''
    try {
      const payload = await getJson<{ reservations: OwnerUserReview[] }>(
        `/api/listings/${encodeURIComponent(id)}/reservation-reviews`,
        signal,
      )
      reservationReviews = payload.reservations
    } catch (caught) {
      if (isAbortError(caught)) return
      reservationReviews = []
      reviewsError = caught instanceof Error ? caught.message : 'Unable to load past reservations for review.'
    } finally {
      if (!signal.aborted) reviewsLoading = false
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

  async function refreshBalance(signal: AbortSignal) {
    try {
      const { summary } = await getJson<{ summary: CreditSummary }>('/api/credits', signal)
      if (summary.balance !== user.creditBalance) onUserUpdated({ ...user, creditBalance: summary.balance })
    } catch {
      // The server still enforces the balance when booking.
    }
  }

  function credits(count: number): string {
    return `${count} credit${count === 1 ? '' : 's'}`
  }

  function initialSlot(): SlotInput {
    const params = new URLSearchParams(backQuery)
    return {
      date: params.get('date') ?? '',
      start: params.get('start') ?? '',
      end: params.get('end') ?? '',
    }
  }

  async function reserve(slot: SlotInput) {
    if (!resource) return
    const response = await sendJson<ReservationWriteResponse>('POST', '/api/reservations', {
      resourceId: resource.id,
      ...slot,
    })
    if (response.credits) onUserUpdated({ ...user, creditBalance: response.credits.balance })
    reserving = false
    window.location.hash = routeHash('reservations')
  }

  async function save(body: FormData, onProgress: (loaded: number, total: number) => void) {
    const payload = await sendForm<{ listing: ListingDetails }>(
      'PATCH',
      `/api/listings/${encodeURIComponent(resourceId)}`,
      body,
      onProgress,
    )
    resource = payload.listing
    ownerDetails = payload.listing
    editing = false
  }

  async function submitReview(input: { reservationId: number; rating: number; reason: string | null; isAnonymous: boolean }) {
    const payload = await sendJson<{ reservation: OwnerUserReview }>(
      'POST',
      `/api/listings/${encodeURIComponent(resourceId)}/reservation-reviews`,
      input,
    )
    reservationReviews = reservationReviews.map((reservation) =>
      reservation.reservationId === payload.reservation.reservationId ? payload.reservation : reservation,
    )
    reviewing = null
  }

  async function confirmDelete() {
    if (!resource || deleteSubmitting) return
    deleteSubmitting = true
    deleteError = ''
    try {
      await sendJson('DELETE', `/api/listings/${encodeURIComponent(resource.id)}`)
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

  onDestroy(() => controller?.abort())
</script>

<svelte:window on:keydown={handleKeydown} />

<section class="resource-detail">
  <a class="back-link" href={backHref}>
    <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 6.5 9 12l5.5 5.5" /></svg>
    {backLabel}
  </a>

  {#if loading && !resource}
    <div class="panel" aria-live="polite"><p class="muted">Loading resource…</p></div>
  {:else if error}
    <div class="notice error-notice state-notice" role="alert">
      <p>{error}</p>
      <button type="button" class="secondary-button" on:click={() => load(resourceId)}>Try again</button>
    </div>
  {:else if resource}
    {#if ownerActive}
      <p class="notice active-listing-notice" role="status">
        Editing and deletion are unavailable while a reservation is in progress
        ({formatDateTime(ownerDetails!.activeReservation!.startTime)} – {formatClock(ownerDetails!.activeReservation!.endTime.slice(11, 16))}).
      </p>
    {/if}
    {#if ownerError}<p class="notice error-notice" role="alert">{ownerError}</p>{/if}
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
          <span class="badge">{resource.category.name}</span>
          <h2>{resource.name}</h2>
          <p class="muted">{resource.building.name} · {resource.locationDescription}</p>
          <p class="muted detail-address">{resource.building.address}</p>
          <p class="resource-card-rating">
            {#if resource.averageRating !== null}<span class="star" aria-hidden="true">★</span>{/if}
            {formatRating(resource.averageRating, resource.reviewCount)}
          </p>

          <div class="reserve-box">
            <div class="detail-actions">
              <button type="button" on:click={() => { pickedSlot = null; pickedNote = ''; reserving = true }} disabled={!affordable || !reviewEligible}>Reserve</button>
              {#if isOwner}
                <button type="button" class="secondary-button" disabled={!canEdit} on:click={() => editing = true}>⚙ Edit</button>
                <button type="button" class="danger-button" disabled={!canDelete} on:click={() => deleting = true}>Delete</button>
              {/if}
            </div>
            {#if isOwner}
              <p class="muted">Owner reservations do not use credits.</p>
            {:else}
              <p class="muted">
                Costs {credits(cost)} per booking · You have {credits(user.creditBalance)}.
                <a class="text-link" href="#/credits">My credits</a>
              </p>
              {#if !affordable}
                <p class="credit-note credit-note-warning">You don't have enough credits to book this resource.</p>
              {/if}
            {/if}
          </div>
        </div>
      </div>

      <div class="detail-info-grid">
        <section class="detail-block detail-block-wide">
          <h3>Description</h3>
          <div class="detail-subsections">
            <div>
              <h4>Resource description</h4>
              <p class="detail-description">{resource.description}</p>
            </div>
            <div>
              <h4>Location description</h4>
              <p class="detail-description">{resource.locationDescription}</p>
            </div>
          </div>
        </section>

        <section class="detail-block">
          <h3>Location</h3>
          <dl class="profile-details detail-facts">
            <div><dt>Building</dt><dd>{resource.building.name}</dd></div>
            <div><dt>Address</dt><dd>{resource.building.address}</dd></div>
            <div><dt>Building coordinates</dt><dd>{resource.building.latitude}, {resource.building.longitude}</dd></div>
          </dl>
        </section>

        <section class="detail-block">
          <h3>Reservation facts</h3>
          <dl class="profile-details detail-facts">
            <div><dt>Capacity</dt><dd>{resource.capacity} {resource.capacity === 1 ? 'person' : 'people'}</dd></div>
            <div><dt>Credits per booking</dt><dd>{resource.requiredCredits}</dd></div>
            <div><dt>Longest booking</dt><dd>{resource.maxReservationMinutes ? formatDuration(resource.maxReservationMinutes) : 'No limit'}</dd></div>
            <div><dt>Listed by</dt><dd>{resource.ownerUsername}</dd></div>
            <div><dt>Minimum user review score</dt><dd>{resource.minUserReviewScore === null ? 'No minimum' : `${resource.minUserReviewScore.toFixed(2)} / 5.00`}</dd></div>
          </dl>
        </section>
      </div>

      <div class="detail-columns">
        <section class="detail-block feature-detail-block">
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

        <section class="detail-block detail-availability">
          <h3>Availability</h3>
          {#key resource.id}
            <AvailabilityCalendar
              resourceId={resource.id}
              onPickSlot={reviewEligible ? (slotResource, start, date) => {
                const suggestion = suggestSlot(slotResource, date, start)
                pickedSlot = suggestion.slot
                pickedNote = suggestion.note
                reserving = true
              } : undefined}
              onPickBooking={() => (window.location.hash = routeHash('reservations'))}
            />
          {/key}
        </section>
      </div>

      <div class="detail-columns detail-secondary-grid">
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
      </div>

      {#if isOwner}
        <section class="detail-block detail-block-wide owner-review-block" aria-labelledby="past-reservations-title">
          <div class="section-heading-row">
            <div>
              <h3 id="past-reservations-title">Past reservations</h3>
              <p class="muted">Review completed reservations from the past seven days.</p>
            </div>
          </div>
          {#if ownerLoading || reviewsLoading}
            <p class="muted" aria-live="polite">Loading past reservations…</p>
          {:else if reviewsError}
            <div class="notice error-notice" role="alert">
              <p>{reviewsError}</p>
              <button type="button" class="secondary-button" on:click={() => loadReservationReviews(resourceId, new AbortController().signal)}>Try again</button>
            </div>
          {:else if reservationReviews.length === 0}
            <p class="muted">No completed reservations from the past seven days.</p>
          {:else}
            <ul class="owner-review-list">
              {#each reservationReviews as reservation (reservation.reservationId)}
                <li class="owner-review-row">
                  <div>
                    <strong><a href={`#/users/${reservation.reserver.id}`}>{reservation.reserver.username}</a></strong>
                    <span class="muted">{formatDateTime(reservation.startTime)} – {formatClock(reservation.endTime.slice(11, 16))}</span>
                  </div>
                  {#if reservation.review}
                    <div class="owner-review-complete">
                      <span class="status-badge status-completed">Reviewed</span>
                      <span class="star" aria-label={`${reservation.review.rating} out of 5 stars`}>{'★'.repeat(reservation.review.rating)}{'☆'.repeat(Math.max(0, 5 - reservation.review.rating))}</span>
                    </div>
                  {:else}
                    <button type="button" class="secondary-button" on:click={() => reviewing = reservation}>Review reservation</button>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      {/if}
    </article>

    {#if reserving}
      <ReservationForm
        title={resource.name}
        subtitle={pickedSlot && pickedNote ? pickedNote : 'Reserve'}
        submitLabel="Reserve"
        initial={pickedSlot ?? initialSlot()}
        maxMinutes={resource.maxReservationMinutes ?? 240}
        note={isOwner
          ? 'Owner reservations do not use credits. Cancel before the reservation starts if your plans change.'
          : `This booking costs ${credits(cost)}. You have ${credits(user.creditBalance)}, so ${credits(Math.max(0, user.creditBalance - cost))} will remain. Cancel at least 24 hours ahead for a full refund.`}
        noteWarning={!isOwner && !affordable}
        onSubmit={reserve}
        onClose={() => { reserving = false; pickedSlot = null }}
      />
    {/if}
  {/if}
</section>

{#if editing && ownerDetails && options}
  <ResourceForm title="Edit resource" submitLabel="Save changes" initial={ownerDetails} {options} onSubmit={save} onClose={() => editing = false} />
{/if}

{#if reviewing}
  <ReservationReviewForm reservation={reviewing} onSubmit={submitReview} onClose={() => reviewing = null} />
{/if}

{#if deleting && resource}
  <div class="modal-layer">
    <button type="button" class="modal-backdrop" aria-label="Keep listing" on:click={closeDelete}></button>
    <dialog open class="modal" aria-labelledby="delete-listing-title" role="alertdialog">
      <div class="modal-heading"><div><p class="eyebrow">Delete listing</p><h2 id="delete-listing-title">Delete {resource.name}?</h2></div><button type="button" class="modal-close" aria-label="Keep listing" on:click={closeDelete}>×</button></div>
      <p>This permanently removes the listing, its image, and its reservation history.</p>
      {#if deleteError}<p class="notice error-notice form-error" role="alert">{deleteError}</p>{/if}
      <div class="form-actions"><button type="button" class="secondary-button" on:click={closeDelete} disabled={deleteSubmitting}>Keep listing</button><button type="button" class="danger-button" on:click={confirmDelete} disabled={deleteSubmitting}>{deleteSubmitting ? 'Deleting…' : 'Delete permanently'}</button></div>
    </dialog>
  </div>
{/if}
