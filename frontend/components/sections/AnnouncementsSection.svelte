<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { getJson, isAbortError, sendJson } from '../../lib/api'
  import { formatDateTime } from '../../lib/format'
  import type { Announcement, AnnouncementType, Reservation, ReviewInbox, UserReviewTask } from '../../lib/types'
  import ResourceReviewForm from '../reservations/ResourceReviewForm.svelte'
  import ReservationReviewForm from '../reservations/ReservationReviewForm.svelte'

  export let query = ''

  const TYPE_LABELS: Record<AnnouncementType, string> = {
    maintenance: 'Maintenance',
    new: 'New',
  }
  type PageFilter = AnnouncementType | '' | 'reviews'

  const FILTERS: Array<{ value: PageFilter; label: string }> = [
    { value: '', label: 'All' },
    { value: 'maintenance', label: 'Maintenance' },
    { value: 'new', label: 'New resources' },
    { value: 'reviews', label: 'Reviews' },
  ]
  const EMPTY_MESSAGES: Record<AnnouncementType | '', string> = {
    '': 'There are no announcements right now.',
    maintenance: 'No current or upcoming maintenance.',
    new: 'No resources were added in the last 30 days.',
  }

  let type: PageFilter = ''
  let announcements: Announcement[] = []
  let loading = true
  let error = ''
  let controller: AbortController | undefined

  let reviewData: ReviewInbox | null = null
  let reviewsLoading = false
  let reviewsError = ''
  let reviewMessage = ''
  let reviewController: AbortController | undefined
  let reviewingResource: Reservation | null = null
  let reviewingUser: UserReviewTask | null = null
  let mixedReviewTasks: MixedReviewTask[] = []

  type MixedReviewTask =
    | { key: string; kind: 'resource'; reservation: Reservation }
    | { key: string; kind: 'user'; userReview: UserReviewTask }

  $: requestedReviews = new URLSearchParams(query).get('tab') === 'reviews'
  $: announcementType = type === 'reviews' ? '' : type
  $: mixedReviewTasks = reviewData
    ? [
        ...reviewData.resourceReviews.map((reservation) => ({
          key: `resource-${reservation.id}`,
          kind: 'resource' as const,
          reservation,
        })),
        ...reviewData.userReviews.map((userReview) => ({
          key: `user-${userReview.reservationId}`,
          kind: 'user' as const,
          userReview,
        })),
      ].sort((left, right) => {
        const leftTime = left.kind === 'resource' ? left.reservation.endTime : left.userReview.endTime
        const rightTime = right.kind === 'resource' ? right.reservation.endTime : right.userReview.endTime
        return rightTime.localeCompare(leftTime)
      })
    : []
  $: if (requestedReviews && type !== 'reviews') {
    type = 'reviews'
    void loadReviews()
  }
  $: if (!requestedReviews && type === 'reviews') {
    type = ''
    void load()
  }

  async function load(filter: AnnouncementType | '' = announcementType) {
    controller?.abort()
    const request = new AbortController()
    controller = request
    loading = true
    error = ''

    try {
      const params = filter ? `?type=${filter}` : ''
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

  function selectType(value: PageFilter) {
    if (value === type) return
    type = value
    if (value === 'reviews') {
      if (window.location.hash !== '#/announcements?tab=reviews') {
        window.location.hash = '#/announcements?tab=reviews'
      }
      void loadReviews()
      return
    }
    if (requestedReviews) window.location.hash = '#/announcements'
    void load(value)
  }

  async function loadReviews() {
    reviewController?.abort()
    const request = new AbortController()
    reviewController = request
    reviewsLoading = true
    reviewsError = ''
    reviewMessage = ''

    try {
      reviewData = await getJson<ReviewInbox>('/api/reviews/mine', request.signal)
    } catch (caught) {
      if (isAbortError(caught)) return
      reviewData = null
      reviewsError = caught instanceof Error ? caught.message : 'Unable to load your review tasks.'
    } finally {
      if (reviewController === request) reviewsLoading = false
    }
  }

  function openResourceReview(reservation: Reservation) {
    reviewMessage = ''
    reviewingResource = reservation
  }

  function openUserReview(task: UserReviewTask) {
    reviewMessage = ''
    reviewingUser = task
  }

  async function submitResourceReview(input: { rating: number; reason: string | null; isAnonymous: boolean }) {
    if (!reviewingResource || !reviewData) return
    const reviewed = reviewingResource
    await sendJson('POST', `/api/reservations/${reviewed.id}/resource-review`, input)
    reviewData = {
      ...reviewData,
      resourceReviews: reviewData.resourceReviews.filter((reservation) => reservation.id !== reviewed.id),
    }
    reviewingResource = null
    reviewMessage = `Thanks for reviewing ${reviewed.resource.name}.`
  }

  async function submitUserReview(input: { reservationId: number; rating: number; reason: string | null; isAnonymous: boolean }) {
    if (!reviewingUser || !reviewData) return
    const reviewed = reviewingUser
    await sendJson('POST', `/api/listings/${reviewed.resource.id}/reservation-reviews`, input)
    reviewData = {
      ...reviewData,
      userReviews: reviewData.userReviews.filter((task) => task.reservationId !== reviewed.reservationId),
    }
    reviewingUser = null
    reviewMessage = `Thanks for reviewing ${reviewed.reserver.username}.`
  }

  onMount(() => {
    if (!requestedReviews) void load()
  })
  onDestroy(() => {
    controller?.abort()
    reviewController?.abort()
  })
</script>

<section class="announcements-page">
  <header class="page-heading">
    <p class="eyebrow">Campus updates</p>
    <h2>Announcements</h2>
    <p class="muted">Maintenance notices, newly listed resources, and reviews that need your attention.</p>
  </header>

  <div class="segmented announcement-filters" role="tablist" aria-label="Announcements and reviews">
    {#each FILTERS as filter (filter.value)}
      <button
        type="button"
        role="tab"
        class="segment"
        class:active={type === filter.value}
        aria-selected={type === filter.value}
        on:click={() => selectType(filter.value)}
      >
        {filter.label}{#if filter.value === 'reviews' && reviewData && (reviewData.resourceReviews.length + reviewData.userReviews.length) > 0} ({reviewData.resourceReviews.length + reviewData.userReviews.length}){/if}
      </button>
    {/each}
  </div>

  {#if type !== 'reviews'}
    {#if loading && announcements.length === 0}
      <div class="panel" aria-live="polite"><p class="muted">Loading announcements…</p></div>
    {:else if error}
      <div class="notice error-notice state-notice" role="alert">
        <p>{error}</p>
        <button type="button" class="secondary-button" on:click={() => load()}>Try again</button>
      </div>
    {:else if announcements.length === 0}
      <div class="panel empty-state">
        <h3>Nothing to announce</h3>
        <p class="muted">{EMPTY_MESSAGES[announcementType]}</p>
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
  {:else}
    {#if reviewMessage}<p class="notice success-notice reservation-message" role="status">{reviewMessage}</p>{/if}

    <div class="reviews-intro panel">
      <h3>Reviews that need your attention</h3>
      <p class="muted">Share feedback about resources you used and students who reserved resources you own.</p>
    </div>

    {#if reviewsLoading && !reviewData}
      <div class="panel" aria-live="polite"><p class="muted">Loading review tasks…</p></div>
    {:else if reviewsError}
      <div class="notice error-notice state-notice" role="alert">
        <p>{reviewsError}</p>
        <button type="button" class="secondary-button" on:click={loadReviews}>Try again</button>
      </div>
    {:else if reviewData}
      <section class="review-task-section" aria-labelledby="review-tasks-title">
        <div class="section-heading-row">
          <div>
            <h3 id="review-tasks-title">Reviews</h3>
          </div>
        </div>
        {#if mixedReviewTasks.length === 0}
          <div class="panel empty-state"><p class="muted">You have no reviews waiting.</p></div>
        {:else}
          <ul class="review-task-list">
            {#each mixedReviewTasks as task (task.key)}
              {#if task.kind === 'resource'}
                <li class="panel review-task-card">
                  <div>
                    <span class="badge">Resource review</span>
                    <h4>{task.reservation.resource.name}</h4>
                    <p class="muted">{task.reservation.building.name} · {formatDateTime(task.reservation.startTime)} – {formatDateTime(task.reservation.endTime)}</p>
                    <p class="review-task-description">Tell other students what to expect from this resource.</p>
                  </div>
                  <button type="button" class="secondary-button" on:click={() => openResourceReview(task.reservation)}>Review resource</button>
                </li>
              {:else}
                <li class="panel review-task-card">
                  <div>
                    <span class="badge">Reservation review</span>
                    <h4>{task.userReview.reserver.username}</h4>
                    <p class="muted">{task.userReview.resource.name} · {task.userReview.building.name} · {formatDateTime(task.userReview.startTime)} – {formatDateTime(task.userReview.endTime)}</p>
                    <p class="review-task-description">Tell other resource owners about this reservation experience.</p>
                  </div>
                  <button type="button" class="secondary-button" on:click={() => openUserReview(task.userReview)}>Review reservation</button>
                </li>
              {/if}
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  {/if}
</section>

{#if reviewingResource}
  <ResourceReviewForm reservation={reviewingResource} onSubmit={submitResourceReview} onClose={() => reviewingResource = null} />
{/if}

{#if reviewingUser}
  <ReservationReviewForm reservation={reviewingUser} onSubmit={submitUserReview} onClose={() => reviewingUser = null} />
{/if}
