<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { getJson, isAbortError } from '../../lib/api'
  import { adminHash } from '../../lib/adminRoutes'
  import { formatDateTime } from '../../lib/format'
  import type { AdminPage, AdminReservation } from '../../lib/types'
  import Pagination from '../Pagination.svelte'

  const PAGE_SIZE = 25
  const FILTERS = [
    { value: '', label: 'All' },
    { value: 'confirmed', label: 'Confirmed' },
    { value: 'active', label: 'Active' },
    { value: 'completed', label: 'Completed' },
    { value: 'cancelled', label: 'Cancelled' },
  ]

  let status = ''
  let page = 1
  let data: AdminPage<AdminReservation> | null = null
  let loading = true
  let error = ''
  let controller: AbortController | undefined

  async function load() {
    controller?.abort()
    const request = new AbortController()
    controller = request
    loading = true
    error = ''

    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
    if (status) params.set('status', status)

    try {
      data = await getJson<AdminPage<AdminReservation>>(`/api/admin/reservations?${params}`, request.signal)
    } catch (caught) {
      if (isAbortError(caught)) return
      data = null
      error = caught instanceof Error ? caught.message : 'Unable to load reservations.'
    } finally {
      if (controller === request) loading = false
    }
  }

  function selectStatus(value: string) {
    if (value === status) return
    status = value
    page = 1
    void load()
  }

  function goTo(next: number) {
    page = next
    void load()
  }

  onMount(load)
  onDestroy(() => controller?.abort())
</script>

<section class="admin-page">
  <header class="page-heading">
    <p class="eyebrow">Administration</p>
    <h2>Reservations</h2>
    <p class="muted">Every reservation across campus.</p>
  </header>

  <div class="segmented" role="group" aria-label="Filter reservations by status">
    {#each FILTERS as filter (filter.value)}
      <button
        type="button"
        class="segment"
        class:active={status === filter.value}
        aria-pressed={status === filter.value}
        on:click={() => selectStatus(filter.value)}
      >
        {filter.label}
      </button>
    {/each}
  </div>

  {#if error}
    <p class="notice error-notice" role="alert">{error}</p>
  {/if}

  <div class="panel table-panel" aria-busy={loading}>
    {#if loading && !data}
      <p class="muted">Loading reservations…</p>
    {:else if data && data.items.length === 0}
      <p class="muted">No reservations found.</p>
    {:else if data}
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr><th>#</th><th>User</th><th>Resource</th><th>Starts</th><th>Ends</th><th>Status</th></tr>
          </thead>
          <tbody>
            {#each data.items as reservation (reservation.id)}
              <tr>
                <td>{reservation.id}</td>
                <td><a href={`${adminHash('users')}/${reservation.user.id}`}>{reservation.user.username}</a></td>
                <td>{reservation.resource.name}</td>
                <td>{formatDateTime(reservation.startTime)}</td>
                <td>{formatDateTime(reservation.endTime)}</td>
                <td><span class={`badge status-${reservation.status}`}>{reservation.status}</span></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onChange={goTo} />
    {/if}
  </div>
</section>
