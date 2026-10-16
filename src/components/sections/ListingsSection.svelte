<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { getJson, isAbortError, sendForm } from '../../lib/api'
  import type { ListingFormOptions, ListingSummary, PublicUser, ResourceFilterOptions } from '../../lib/types'
  import ResourceForm from '../resources/ResourceForm.svelte'

  export let user: PublicUser

  let listings: ListingSummary[] = []
  let options: ListingFormOptions | null = null
  let loading = true
  let error = ''
  let optionsError = ''
  let formOpen = false
  let controller: AbortController | undefined

  async function load() {
    controller?.abort()
    const request = new AbortController()
    controller = request
    loading = true
    error = ''
    try {
      const payload = await getJson<{ listings: ListingSummary[] }>('/api/listings', request.signal)
      listings = payload.listings
    } catch (caught) {
      if (isAbortError(caught)) return
      error = caught instanceof Error ? caught.message : 'Unable to load your listings.'
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

  async function create(body: FormData, onProgress: (loaded: number, total: number) => void) {
    await sendForm<{ listing: ListingSummary }>('POST', '/api/listings', body, onProgress)
    formOpen = false
    await load()
  }

  onMount(() => {
    void load()
    void loadOptions()
  })
  onDestroy(() => controller?.abort())
</script>

<section class="listings-page">
  <div class="page-heading listings-heading">
    <div>
      <h2>My Listings</h2>
      <p class="muted">Manage the resources you offer to the Virginia Tech community.</p>
    </div>
    {#if user.canAddResources}
      <button type="button" class="add-listing-button" aria-label="Create resource" on:click={() => formOpen = true}>+</button>
    {/if}
  </div>

  {#if !user.canAddResources}
    <p class="notice" role="status">Your account is not currently approved to add resources.</p>
  {/if}
  {#if optionsError}<p class="notice error-notice" role="alert">{optionsError}</p>{/if}

  {#if loading && listings.length === 0}
    <div class="panel" aria-live="polite"><p class="muted">Loading your listings…</p></div>
  {:else if error}
    <div class="notice error-notice state-notice" role="alert">
      <p>{error}</p>
      <button type="button" class="secondary-button" on:click={load}>Try again</button>
    </div>
  {:else if listings.length === 0}
    <div class="panel empty-state">
      <p class="muted">You have not listed any resources yet.</p>
      {#if user.canAddResources && options}<button type="button" on:click={() => formOpen = true}>Create your first resource</button>{/if}
    </div>
  {:else}
    <ul class="listing-grid" aria-label="Your resource listings">
      {#each listings as listing (listing.id)}
        <li>
          <a class="listing-card panel" href={`#/listings/${listing.id}`}>
            {#if listing.thumbnailUrl}
              <img class="listing-card-image" src={listing.thumbnailUrl} alt="" loading="lazy" />
            {:else}
              <div class="listing-card-image resource-thumb-placeholder" aria-hidden="true">
                <svg class="nav-icon" viewBox="0 0 24 24"><path d="M4 20V8l8-4 8 4v12" /><path d="M9 20v-6h6v6" /></svg>
              </div>
            {/if}
            <div class="listing-card-body">
              <div class="listing-card-badges">
                <span class="badge">{listing.category.name}</span>
                {#if listing.hasActiveReservation}<span class="badge status-badge status-active">In progress</span>{/if}
              </div>
              <h3>{listing.name}</h3>
              <p class="resource-card-meta">{listing.building.name} · Seats {listing.capacity}</p>
              <p class="resource-card-description">{listing.shortDescription}</p>
              <p class="muted">{listing.reviewCount ? `${listing.reviewCount} review${listing.reviewCount === 1 ? '' : 's'}` : 'No reviews yet'}</p>
            </div>
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</section>

{#if formOpen && options}
  <ResourceForm
    options={options}
    onSubmit={create}
    onClose={() => formOpen = false}
  />
{/if}
