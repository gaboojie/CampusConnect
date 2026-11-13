<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { getJson, isAbortError, sendJson } from '../../lib/api'
  import { adminHash } from '../../lib/adminRoutes'
  import { formatDate } from '../../lib/format'
  import type { AdminPage, AdminUser, AdminUserDetail } from '../../lib/types'
  import AdminCreateUserForm from '../AdminCreateUserForm.svelte'
  import ConfirmDialog from '../ConfirmDialog.svelte'
  import Pagination from '../Pagination.svelte'

  // The signed-in administrator; they can't ban their own account.
  export let currentUserId: number

  const PAGE_SIZE = 25

  let search = ''
  let role = ''
  let status = ''
  let page = 1
  let data: AdminPage<AdminUser> | null = null
  let loading = true
  let error = ''
  let success = ''
  let showCreate = false
  let banTarget: AdminUser | null = null
  let banning = false
  let banError = ''
  let roleTarget: AdminUser | null = null
  let roleSaving = false
  let roleError = ''
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

  function created(user: AdminUserDetail) {
    showCreate = false
    success = `Created ${user.username} (${user.email}).`
    error = ''
    page = 1
    void load()
  }

  function openBanDialog(user: AdminUser) {
    banTarget = user
    banError = ''
    success = ''
  }

  function closeBanDialog() {
    if (!banning) banTarget = null
  }

  async function confirmBan() {
    if (!banTarget) return
    const user = banTarget
    const isBanned = !user.isBanned
    banning = true
    banError = ''

    try {
      await sendJson('PATCH', `/api/admin/users/${user.userId}`, { isBanned })
      success = `${isBanned ? 'Banned' : 'Unbanned'} ${user.username}.`
      banTarget = null
      await load()
    } catch (caught) {
      banError = caught instanceof Error ? caught.message : 'Unable to update this user.'
    } finally {
      banning = false
    }
  }

  function openRoleDialog(user: AdminUser) {
    roleTarget = user
    roleError = ''
    success = ''
  }

  function closeRoleDialog() {
    if (!roleSaving) roleTarget = null
  }

  // Promote to admin, or send an admin back to student.
  async function confirmRole() {
    if (!roleTarget) return
    const user = roleTarget
    const role = user.role === 'admin' ? 'student' : 'admin'
    roleSaving = true
    roleError = ''

    try {
      await sendJson('PATCH', `/api/admin/users/${user.userId}`, { role })
      success = role === 'admin' ? `${user.username} is now an admin.` : `${user.username} is no longer an admin.`
      roleTarget = null
      await load()
    } catch (caught) {
      roleError = caught instanceof Error ? caught.message : 'Unable to change this role.'
    } finally {
      roleSaving = false
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
      <h2>Users</h2>
      <p class="muted">Every registered CampusConnect account.</p>
    </div>
    {#if !showCreate}
      <button type="button" on:click={() => { showCreate = true; success = '' }}>Create user</button>
    {/if}
  </header>

  {#if showCreate}
    <AdminCreateUserForm onCreated={created} onCancel={() => (showCreate = false)} />
  {/if}

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
  {#if success}
    <p class="notice success-notice" role="status">{success}</p>
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
              <th>Username</th><th>Email</th><th>Role</th><th>Status</th><th>Credits</th><th>Joined</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each data.items as user (user.userId)}
              <tr>
                <td><a href={`${adminHash('users')}/${user.userId}`}>{user.username}</a></td>
                <td>{user.email}</td>
                <td><span class="badge">{user.role}</span></td>
                <td><span class={`badge user-status-${user.status}`}>{user.status}</span></td>
                <td>{user.creditBalance}</td>
                <td>{formatDate(user.createdAt.slice(0, 10))}</td>
                <td>
                  <div class="row-actions">
                    <a
                      class="icon-button"
                      href={`${adminHash('users')}/${user.userId}`}
                      aria-label={`Edit ${user.username}`}
                      title="Edit user"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="m4 16.5-.75 3.75L7 19.5 18.25 8.25a2.12 2.12 0 0 0-3-3L4 16.5Z" />
                        <path d="m13.75 6.75 3.5 3.5" />
                      </svg>
                    </a>
                    {#if user.userId === currentUserId}
                      <span class="muted">You</span>
                    {:else}
                      <button
                        type="button"
                        class={user.isBanned ? 'icon-button' : 'icon-button icon-danger'}
                        aria-label={`${user.isBanned ? 'Unban' : 'Ban'} ${user.username}`}
                        title={user.isBanned ? 'Unban user' : 'Ban user'}
                        on:click={() => openBanDialog(user)}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <circle cx="12" cy="12" r="8" />
                          {#if user.isBanned}
                            <path d="m8.5 12.5 2.5 2.5 4.5-5" />
                          {:else}
                            <path d="M6.4 6.4 17.6 17.6" />
                          {/if}
                        </svg>
                      </button>
                      <button
                        type="button"
                        class={user.role === 'admin' ? 'icon-button icon-danger' : 'icon-button'}
                        aria-label={`${user.role === 'admin' ? 'Remove admin from' : 'Make admin'} ${user.username}`}
                        title={user.role === 'admin' ? 'Remove admin' : 'Make admin'}
                        on:click={() => openRoleDialog(user)}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M12 3.5 5 6.5v5.2c0 4.1 2.8 7 7 8.8 4.2-1.8 7-4.7 7-8.8V6.5Z" />
                          {#if user.role === 'admin'}
                            <path d="M9.5 11.5h5" />
                          {:else}
                            <path d="M12 9v5M9.5 11.5h5" />
                          {/if}
                        </svg>
                      </button>
                    {/if}
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

{#if banTarget}
  <ConfirmDialog
    eyebrow={banTarget.isBanned ? 'Restore access' : 'Restrict access'}
    title={banTarget.isBanned ? `Unban ${banTarget.username}?` : `Ban ${banTarget.username}?`}
    confirmLabel={banTarget.isBanned ? 'Unban user' : 'Ban user'}
    busyLabel="Saving…"
    danger={!banTarget.isBanned}
    busy={banning}
    error={banError}
    onConfirm={confirmBan}
    onCancel={closeBanDialog}
  >
    {#if banTarget.isBanned}
      <p>Unbanning <strong>{banTarget.username}</strong> restores their full access to CampusConnect.</p>
    {:else}
      <p>
        <strong>{banTarget.username}</strong> will only be able to view their profile and delete their account.
        Their existing reservations are kept. You can unban them at any time.
      </p>
    {/if}
  </ConfirmDialog>
{/if}

{#if roleTarget}
  <ConfirmDialog
    eyebrow="Change role"
    title={roleTarget.role === 'admin' ? `Remove admin from ${roleTarget.username}?` : `Make ${roleTarget.username} an admin?`}
    confirmLabel={roleTarget.role === 'admin' ? 'Remove admin' : 'Make admin'}
    busyLabel="Saving…"
    danger={roleTarget.role === 'admin'}
    busy={roleSaving}
    error={roleError}
    onConfirm={confirmRole}
    onCancel={closeRoleDialog}
  >
    {#if roleTarget.role === 'admin'}
      <p><strong>{roleTarget.username}</strong> will lose access to the admin panel and become a student.</p>
    {:else}
      <p>
        <strong>{roleTarget.username}</strong> will be able to create, edit, ban and delete users, and delete resources.
        Only do this for people you trust.
      </p>
    {/if}
  </ConfirmDialog>
{/if}
