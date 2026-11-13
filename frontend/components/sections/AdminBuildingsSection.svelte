<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { getJson, isAbortError, sendJson } from '../../lib/api'
  import type { AdminBuilding, AdminPage } from '../../lib/types'
  import AdminBuildingForm from '../AdminBuildingForm.svelte'
  import ConfirmDialog from '../ConfirmDialog.svelte'
  import Pagination from '../Pagination.svelte'

  const PAGE_SIZE = 25

  let search = ''
  let page = 1
  let data: AdminPage<AdminBuilding> | null = null
  let loading = true
  let error = ''
  let success = ''
  let showCreate = false
  let editing: AdminBuilding | null = null
  let deleteTarget: AdminBuilding | null = null
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
      data = await getJson<AdminPage<AdminBuilding>>(`/api/admin/buildings?${params}`, request.signal)
    } catch (caught) {
      if (isAbortError(caught)) return
      data = null
      error = caught instanceof Error ? caught.message : 'Unable to load buildings.'
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

  function saved(building: AdminBuilding, created: boolean) {
    showCreate = false
    editing = null
    success = created ? `Added ${building.name}.` : `Updated ${building.name}.`
    void load()
  }

  function askDelete(building: AdminBuilding) {
    success = ''
    deleteError = ''
    if (building.resourceCount > 0) {
      const noun = building.resourceCount === 1 ? 'resource' : 'resources'
      error = `${building.name} still has ${building.resourceCount} ${noun}. Move or delete them before deleting this building.`
      return
    }
    error = ''
    deleteTarget = building
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
      await sendJson('DELETE', `/api/admin/buildings/${target.id}`)
      success = `Deleted ${target.name}.`
      deleteTarget = null
      if (data && data.items.length === 1 && page > 1) page -= 1
      await load()
    } catch (caught) {
      deleteError = caught instanceof Error ? caught.message : 'Unable to delete this building.'
    } finally {
      deleting = false
    }
  }

  onMount(load)
  onDestroy(() => {
    controller?.abort()
    clearTimeout(searchTimer)
  })
</script>

<section class="admin-page">
  <header class="page-heading section-heading-row">
    <div>
      <p class="eyebrow">Administration</p>
      <h2>Buildings</h2>
      <p class="muted">Add a campus building, update its details, or delete it when it has no resources.</p>
    </div>
    {#if !showCreate && !editing}
      <button type="button" on:click={() => { showCreate = true; success = ''; error = '' }}>Add building</button>
    {/if}
  </header>

  <div class="admin-toolbar">
    <label>
      Search
      <input type="search" placeholder="Building name or address" bind:value={search} on:input={searchChanged} />
    </label>
  </div>

  {#if showCreate}
    <AdminBuildingForm onSaved={(building) => saved(building, true)} onCancel={() => (showCreate = false)} />
  {:else if editing}
    {#key editing.id}
      <AdminBuildingForm
        building={editing}
        onSaved={(building) => saved(building, false)}
        onCancel={() => (editing = null)}
      />
    {/key}
  {/if}

  {#if error}
    <p class="notice error-notice" role="alert">{error}</p>
  {/if}
  {#if success}
    <p class="notice success-notice" role="status">{success}</p>
  {/if}

  <div class="panel table-panel" aria-busy={loading}>
    {#if loading && !data}
      <p class="muted">Loading buildings…</p>
    {:else if data && data.items.length === 0}
      <p class="muted">No buildings match this search.</p>
    {:else if data}
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th>Building</th><th>Address</th><th>Coordinates</th><th>Resources</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each data.items as building (building.id)}
              <tr>
                <td>{building.name}</td>
                <td>{building.address}</td>
                <td>{building.latitude}, {building.longitude}</td>
                <td>{building.resourceCount}</td>
                <td>
                  <div class="row-actions">
                    <button
                      type="button"
                      class="icon-button"
                      aria-label={`Edit ${building.name}`}
                      title="Edit building"
                      on:click={() => { editing = building; showCreate = false; success = ''; error = '' }}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M4 20h4L18 10l-4-4L4 16v4Z" />
                        <path d="M13 7l4 4" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      class="icon-button icon-danger"
                      aria-label={`Delete ${building.name}`}
                      title="Delete building"
                      on:click={() => askDelete(building)}
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

{#if deleteTarget}
  <ConfirmDialog
    eyebrow="This cannot be undone"
    title={`Delete ${deleteTarget.name}?`}
    confirmLabel="Delete building"
    busyLabel="Deleting…"
    danger
    busy={deleting}
    error={deleteError}
    onConfirm={confirmDelete}
    onCancel={cancelDelete}
  >
    <p>This removes {deleteTarget.name} from the building list. Resources can no longer be assigned to it.</p>
  </ConfirmDialog>
{/if}
