<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { getJson, isAbortError, sendJson } from '../../lib/api'
  import { adminHash } from '../../lib/adminRoutes'
  import type { AdminPage, AdminResource } from '../../lib/types'
  import AdminResourceDetailsDialog from '../AdminResourceDetailsDialog.svelte'
  import ConfirmDialog from '../ConfirmDialog.svelte'
  import Pagination from '../Pagination.svelte'

  type DeleteTarget = { id: number; name: string; upcomingReservations: number }

  const PAGE_SIZE = 25

  let search = ''
  let page = 1
  let data: AdminPage<AdminResource> | null = null
  let loading = true
  let error = ''
  let success = ''
  let detailsId: number | null = null
  let deleteTarget: DeleteTarget | null = null
  let deleting = false
  let deleteError = ''
  let controller: AbortController | undefined
  let searchTimer: ReturnType<typeof setTimeout> | undefined

  async function load() {
    controller?.abort()
    const request = new AbortController()
    controller = request
    loading = true
    error = ''

    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
    if (search.trim()) params.set('search', search.trim())

    try {
      data = await getJson<AdminPage<AdminResource>>(`/api/admin/resources?${params}`, request.signal)
    } catch (caught) {
      if (isAbortError(caught)) return
      data = null
      error = caught instanceof Error ? caught.message : 'Unable to load resources.'
    } finally {
      if (controller === request) loading = false
    }
  }

  function searchChanged() {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      page = 1
      void load()
    }, 300)
  }

  function goTo(next: number) {
    page = next
    void load()
  }

  function askDelete(target: DeleteTarget) {
    // Close the details popup first so only one dialog is open at a time.
    detailsId = null
    deleteTarget = target
    deleteError = ''
    success = ''
  }

  function cancelDelete() {
    if (!deleting) deleteTarget = null
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    const target = deleteTarget
    deleting = true
    deleteError = ''

    try {
      const result = await sendJson<{ cancelledReservations: number }>('DELETE', `/api/admin/resources/${target.id}`)
      const cancelled = result.cancelledReservations
      success =
        `Deleted “${target.name}”.` +
        (cancelled > 0
          ? ` ${cancelled} upcoming reservation${cancelled === 1 ? ' was' : 's were'} cancelled and refunded.`
          : '')
      deleteTarget = null
      // Step back a page when the last row on this page was just removed.
      if (data && data.items.length === 1 && page > 1) page -= 1
      await load()
    } catch (caught) {
      deleteError = caught instanceof Error ? caught.message : 'Unable to delete this resource.'
    } finally {
      deleting = false
    }
  }

  function rowKeydown(event: KeyboardEvent, id: number) {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      detailsId = id
    }
  }

  onMount(load)
  onDestroy(() => {
    controller?.abort()
    clearTimeout(searchTimer)
  })
</script>

<section class="admin-page">
  <header class="page-heading">
    <p class="eyebrow">Administration</p>
    <h2>Resources</h2>
    <p class="muted">Select a resource to see its full details.</p>
  </header>

  <div class="admin-toolbar">
    <label>
      Search
      <input type="search" placeholder="Resource, owner, or building" bind:value={search} on:input={searchChanged} />
    </label>
  </div>

  {#if error}
    <p class="notice error-notice" role="alert">{error}</p>
  {/if}
  {#if success}
    <p class="notice success-notice" role="status">{success}</p>
  {/if}

  <div class="panel table-panel" aria-busy={loading}>
    {#if loading && !data}
      <p class="muted">Loading resources…</p>
    {:else if data && data.items.length === 0}
      <p class="muted">No resources match this search.</p>
    {:else if data}
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th>Resource</th><th>Building</th><th>Owner</th><th>Upcoming</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each data.items as resource (resource.id)}
              <tr
                class="clickable-row"
                tabindex="0"
                aria-label={`View details for ${resource.name}`}
                on:click={() => (detailsId = resource.id)}
                on:keydown={(event) => rowKeydown(event, resource.id)}
              >
                <td>{resource.name}</td>
                <td>{resource.building.name}</td>
                <td>
                  <a href={`${adminHash('users')}/${resource.owner.id}`} on:click|stopPropagation>{resource.owner.username}</a>
                </td>
                <td>{resource.upcomingReservations}</td>
                <td>
                  <div class="row-actions">
                    <button
                      type="button"
                      class="icon-button"
                      aria-label={`View ${resource.name}`}
                      title="View details"
                      on:click|stopPropagation={() => (detailsId = resource.id)}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
                        <circle cx="12" cy="12" r="2.8" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      class="icon-button icon-danger"
                      aria-label={`Delete ${resource.name}`}
                      title="Delete resource"
                      on:click|stopPropagation={() => askDelete({
                        id: resource.id,
                        name: resource.name,
                        upcomingReservations: resource.upcomingReservations,
                      })}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M4.5 7h15" />
                        <path d="M9.5 7V4.5h5V7" />
                        <path d="M6.5 7l.8 12.5h9.4L17.5 7" />
                        <path d="M10 11v5M14 11v5" />
                      </svg>
                    </button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onChange={goTo} />
    {/if}
  </div>
</section>

{#if detailsId !== null}
  {#key detailsId}
    <AdminResourceDetailsDialog
      resourceId={detailsId}
      onClose={() => (detailsId = null)}
      onDelete={(resource) => askDelete({
        id: resource.id,
        name: resource.name,
        upcomingReservations: resource.upcomingReservations,
      })}
    />
  {/key}
{/if}

{#if deleteTarget}
  <ConfirmDialog
    eyebrow="This cannot be undone"
    title={`Delete ${deleteTarget.name}?`}
    confirmLabel="Delete resource"
    busyLabel="Deleting…"
    danger
    busy={deleting}
    error={deleteError}
    onConfirm={confirmDelete}
    onCancel={cancelDelete}
  >
    <p>
      <strong>{deleteTarget.name}</strong> will be permanently removed, along with its photo, availability,
      reviews and reservation history.
    </p>
    {#if deleteTarget.upcomingReservations > 0}
      <p class="safety-note">
        {deleteTarget.upcomingReservations} upcoming reservation{deleteTarget.upcomingReservations === 1 ? '' : 's'}
        will be cancelled, the credits refunded, and each person emailed.
      </p>
    {:else}
      <p class="muted">It has no upcoming reservations, so nobody will be affected.</p>
    {/if}
  </ConfirmDialog>
{/if}
