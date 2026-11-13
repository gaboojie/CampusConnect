<script lang="ts">
  import { onDestroy } from 'svelte'
  import { getJson, isAbortError } from '../../lib/api'
  import { formatDate } from '../../lib/format'
  import type { UserReviewPage } from '../../lib/types'
  import Pagination from '../Pagination.svelte'

  export let userId: string

  const PAGE_SIZE = 10
  let data: UserReviewPage | null = null
  let page = 1
  let loading = true
  let error = ''
  let controller: AbortController | undefined

  $: if (userId) void load(userId, page)

  async function load(id: string, requestedPage: number) {
    controller?.abort()
    const request = new AbortController()
    controller = request
    loading = true
    error = ''

    try {
      data = await getJson<UserReviewPage>(
        `/api/users/${encodeURIComponent(id)}/reviews?page=${requestedPage}&pageSize=${PAGE_SIZE}`,
        request.signal,
      )
    } catch (caught) {
      if (isAbortError(caught)) return
      data = null
      error = caught instanceof Error ? caught.message : 'Unable to load user reviews.'
    } finally {
      if (controller === request) loading = false
    }
  }

  function goTo(nextPage: number) {
    page = nextPage
  }

  onDestroy(() => controller?.abort())
</script>

<section class="user-reviews-section" aria-labelledby="user-reviews-title">
  <div class="section-heading-row">
    <div>
      <h3 id="user-reviews-title">User Reviews</h3>
    </div>
    {#if data && data.total > 0}
      <div class="review-summary" aria-label="Review summary">
        <strong>{data.averageRating === null ? '—' : data.averageRating.toFixed(1)}</strong>
        <span class="muted">average · {data.total} review{data.total === 1 ? '' : 's'}</span>
      </div>
    {/if}
  </div>

  {#if loading && !data}
    <p class="muted" aria-live="polite">Loading reviews…</p>
  {:else if error}
    <div class="notice error-notice" role="alert"><p>{error}</p><button type="button" class="secondary-button" on:click={() => load(userId, page)}>Try again</button></div>
  {:else if data && data.items.length === 0}
    <p class="muted">No reservation reviews yet.</p>
  {:else if data}
    <ul class="review-list user-review-list">
      {#each data.items as review (review.id)}
        <li class="review">
          <p class="review-heading">
            <span class="star" aria-label={`${review.rating} out of 5 stars`}>{'★'.repeat(review.rating)}{'☆'.repeat(Math.max(0, 5 - review.rating))}</span>
            <span class="muted">{formatDate(review.createdAt)} · {#if review.reviewer}<a href={`#/users/${review.reviewer.id}`}>{review.reviewer.username}</a>{:else}Anonymous{/if}</span>
          </p>
          <p class="user-review-resource"><a href={`#/resources/${review.resource.id}`}>{review.resource.name}</a></p>
          {#if review.reason}<p>{review.reason}</p>{/if}
        </li>
      {/each}
    </ul>
    <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onChange={goTo} />
  {/if}
</section>
