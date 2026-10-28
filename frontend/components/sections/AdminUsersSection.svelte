<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { getJson, isAbortError } from '../../lib/api'
  import { adminHash } from '../../lib/adminRoutes'
  import { formatDate } from '../../lib/format'
  import type { AdminPage, AdminUser } from '../../lib/types'
  import Pagination from '../Pagination.svelte'

  const PAGE_SIZE = 25

  let search = ''
  let role = ''
  let status = ''
  let page = 1
  let data: AdminPage<AdminUser> | null = null
  let loading = true
  let error = ''
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
    if (role) params.set('role', role)
    if (status) params.set('status', status)

    try {
      data = await getJson<AdminPage<AdminUser>>(`/api/admin/users?${params}`, request.signal)
    } catch (caught) {
      if (isAbortError(caught)) return
      data = null
      error = caught instanceof Error ? caught.message : 'Unable to load users.'
    } finally {
      if (controller === request) loading = false
    }
  }

  function filterChanged() {
    page = 1
    void load()
  }

  function searchChanged() {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(filterChanged, 300)
  }

  function goTo(next: number) {
    page = next
    void load()
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
    <h2>Users</h2>
    <p class="muted">Every registered CampusConnect account.</p>
  </header>

  <div class="admin-toolbar">
    <label>
      Search
      <input type="search" placeholder="Username or email" bind:value={search} on:input={searchChanged} />
    </label>
    <label>
      Role
      <select bind:value={role} on:change={filterChanged}>
        <option value="">All roles</option>
        <option value="student">Student</option>
        <option value="staff">Staff</option>
        <option value="admin">Admin</option>
      </select>
    </label>
    <label>
      Status
      <select bind:value={status} on:change={filterChanged}>
        <option value="">All statuses</option>
        <option value="active">Active</option>
        <option value="unverified">Unverified</option>
        <option value="banned">Banned</option>
      </select>
    </label>
  </div>

  {#if error}
    <p class="notice error-notice" role="alert">{error}</p>
  {/if}

  <div class="panel table-panel" aria-busy={loading}>
    {#if loading && !data}
      <p class="muted">Loading users…</p>
    {:else if data && data.items.length === 0}
      <p class="muted">No users match these filters.</p>
    {:else if data}
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th>Username</th><th>Email</th><th>Phone</th><th>Role</th><th>Status</th><th>Credits</th><th>Joined</th>
            </tr>
          </thead>
          <tbody>
            {#each data.items as user (user.userId)}
              <tr>
                <td><a href={`${adminHash('users')}/${user.userId}`}>{user.username}</a></td>
                <td>{user.email}</td>
                <td>{user.phoneNumber ?? '—'}</td>
                <td><span class="badge">{user.role}</span></td>
                <td><span class={`badge user-status-${user.status}`}>{user.status}</span></td>
                <td>{user.creditBalance}</td>
                <td>{formatDate(user.createdAt.slice(0, 10))}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onChange={goTo} />
    {/if}
  </div>
</section>
