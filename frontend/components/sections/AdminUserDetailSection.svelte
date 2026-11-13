<script lang="ts">
  import { onMount } from 'svelte'
  import { ApiError, getJson, sendJson } from '../../lib/api'
  import { adminHash } from '../../lib/adminRoutes'
  import { formatDate, formatDateTime } from '../../lib/format'
  import type { AdminUserDetail } from '../../lib/types'
  import ConfirmDialog from '../ConfirmDialog.svelte'

  export let userId: string
  // The signed-in administrator; they can't ban or demote themselves.
  export let currentUserId: number

  let user: AdminUserDetail | null = null
  let loading = true
  let error = ''
  let success = ''

  let editing = false
  let saving = false
  let formError = ''
  let fieldErrors: Record<string, string> = {}
  let usernameDraft = ''
  let emailDraft = ''
  let roleDraft = 'student'
  let canAddResourcesDraft = false
  let emailNotificationsDraft = false

  let confirmingBan = false
  let banError = ''

  $: isSelf = user !== null && user.userId === currentUserId

  onMount(async () => {
    try {
      user = (await getJson<{ user: AdminUserDetail }>(`/api/admin/users/${userId}`)).user
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Unable to load this user.'
    } finally {
      loading = false
    }
  })

  function startEditing() {
    if (!user) return
    usernameDraft = user.username
    emailDraft = user.email
    roleDraft = user.role
    canAddResourcesDraft = user.canAddResources
    emailNotificationsDraft = user.emailNotificationsOn
    formError = ''
    fieldErrors = {}
    success = ''
    editing = true
  }

  async function save() {
    if (!user) return

    // Send only what changed so an untouched field can't trip a validation rule.
    const changes: Record<string, string | boolean> = {}
    if (usernameDraft.trim() !== user.username) changes.username = usernameDraft.trim()
    if (emailDraft.trim().toLowerCase() !== user.email) changes.email = emailDraft.trim()
    if (roleDraft !== user.role) changes.role = roleDraft
    if (canAddResourcesDraft !== user.canAddResources) changes.canAddResources = canAddResourcesDraft
    if (emailNotificationsDraft !== user.emailNotificationsOn) changes.emailNotificationsOn = emailNotificationsDraft

    if (Object.keys(changes).length === 0) {
      editing = false
      return
    }

    saving = true
    formError = ''
    fieldErrors = {}

    try {
      user = (await sendJson<{ user: AdminUserDetail }>('PATCH', `/api/admin/users/${user.userId}`, changes)).user
      editing = false
      success = 'Changes saved.'
    } catch (caught) {
      formError = caught instanceof Error ? caught.message : 'Unable to save these changes.'
      if (caught instanceof ApiError) fieldErrors = caught.fieldErrors
    } finally {
      saving = false
    }
  }

  async function setBanned(isBanned: boolean) {
    if (!user) return
    saving = true
    banError = ''

    try {
      user = (await sendJson<{ user: AdminUserDetail }>('PATCH', `/api/admin/users/${user.userId}`, { isBanned })).user
      confirmingBan = false
      success = isBanned ? 'User banned.' : 'User unbanned.'
    } catch (caught) {
      banError = caught instanceof Error ? caught.message : 'Unable to update this user.'
    } finally {
      saving = false
    }
  }

  let roleDialogOpen = false
  let roleSaving = false
  let roleError = ''

  // Promote to admin, or send an admin back to student.
  async function toggleAdmin() {
    if (!user) return
    roleSaving = true
    roleError = ''

    try {
      const role = user.role === 'admin' ? 'student' : 'admin'
      user = (await sendJson<{ user: AdminUserDetail }>('PATCH', `/api/admin/users/${user.userId}`, { role })).user
      roleDialogOpen = false
      success = role === 'admin' ? 'User is now an admin.' : 'Admin access removed.'
    } catch (caught) {
      roleError = caught instanceof Error ? caught.message : 'Unable to change this role.'
    } finally {
      roleSaving = false
    }
  }

  let deleteOpen = false
  let deleteConfirm = ''
  let deleting = false
  let deleteError = ''
  let deleted = false

  async function deleteAccount() {
    if (!user) return
    deleting = true
    deleteError = ''

    try {
      await sendJson('DELETE', `/api/admin/users/${user.userId}`)
      deleted = true
    } catch (caught) {
      deleteError = caught instanceof Error ? caught.message : 'Unable to delete this account.'
    } finally {
      deleting = false
    }
  }

  const yesNo = (value: boolean) => (value ? 'Yes' : 'No')
  const onOff = (value: boolean) => (value ? 'On' : 'Off')
</script>

<section class="admin-page">
  <a class="back-link" href={adminHash('users')}>← All users</a>

  {#if loading}
    <div class="panel"><p class="muted">Loading user…</p></div>
  {:else if deleted && user}
    <div class="panel">
      <p class="notice success-notice" role="status">Deleted the account for {user.username}.</p>
      <a class="button-link" href={adminHash('users')}>Back to all users</a>
    </div>
  {:else if user}
    {#if error}
      <p class="notice error-notice" role="alert">{error}</p>
    {/if}
    {#if success}
      <p class="notice success-notice" role="status">{success}</p>
    {/if}

    <div class="panel profile-card">
      <div class="profile-heading">
        <div>
          <p class="eyebrow">User #{user.userId}</p>
          <h2>{user.username}</h2>
          <p class="muted">{user.email}</p>
        </div>
        <div class="row-actions">
          <span class={`badge user-status-${user.status}`}>{user.status}</span>
          {#if !editing}
            <button type="button" class="secondary-button" on:click={startEditing}>Edit user</button>
          {/if}
        </div>
      </div>

      {#if editing}
        <form class="admin-form" on:submit|preventDefault={save}>
          {#if formError}
            <p class="notice error-notice" role="alert">{formError}</p>
          {/if}

          <div class="admin-form-grid">
            <label>
              Username
              <input bind:value={usernameDraft} minlength="3" maxlength="32" required />
              {#if fieldErrors.username}<span class="field-error">{fieldErrors.username}</span>{/if}
            </label>
            <label>
              Email
              <input type="email" bind:value={emailDraft} required />
              {#if fieldErrors.email}<span class="field-error">{fieldErrors.email}</span>{/if}
            </label>
            <label>
              Role
              <select bind:value={roleDraft} disabled={isSelf}>
                <option value="student">Student</option>
                <option value="staff">Staff</option>
                <option value="admin">Admin</option>
              </select>
              {#if isSelf}<span class="muted">You can't change your own role.</span>{/if}
              {#if fieldErrors.role}<span class="field-error">{fieldErrors.role}</span>{/if}
            </label>
          </div>

          <label class="checkbox-label">
            <input type="checkbox" bind:checked={canAddResourcesDraft} />
            Can list resources
          </label>
          <label class="checkbox-label">
            <input type="checkbox" bind:checked={emailNotificationsDraft} />
            Email notifications on
          </label>

          <div class="password-actions">
            <button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
            <button type="button" class="secondary-button" disabled={saving} on:click={() => (editing = false)}>Cancel</button>
          </div>
        </form>
      {:else}
        <dl class="profile-details">
          <div><dt>Role</dt><dd>{user.role}</dd></div>
          <div><dt>Joined</dt><dd>{formatDateTime(user.createdAt.slice(0, 19))}</dd></div>
          <div><dt>Email verified</dt><dd>{user.emailVerifiedAt ? formatDateTime(user.emailVerifiedAt.slice(0, 19)) : 'Not verified'}</dd></div>
          <div><dt>Credits</dt><dd>{user.creditBalance}</dd></div>
          <div><dt>Credits last reset</dt><dd>{formatDate(user.creditLastReset)}</dd></div>
          <div><dt>Can add resources</dt><dd>{yesNo(user.canAddResources)}</dd></div>
          <div><dt>Banned</dt><dd>{yesNo(user.isBanned)}</dd></div>
          <div><dt>Email notifications</dt><dd>{onOff(user.emailNotificationsOn)}</dd></div>
          <div><dt>Resources owned</dt><dd>{user.resourcesOwned}</dd></div>
          <div>
            <dt>Reservations</dt>
            <dd>
              {#each Object.entries(user.reservationCounts) as [status, count]}
                <span class={`badge status-${status}`}>{status}: {count}</span>{' '}
              {:else}
                None
              {/each}
            </dd>
          </div>
        </dl>
      {/if}
    </div>

    <div class="panel account-danger-zone">
      <div>
        <h3>Administrator access</h3>
        <p class="muted">
          {#if isSelf}
            You're an administrator. You can't remove your own access.
          {:else if user.role === 'admin'}
            This user is an administrator and can manage users and resources.
          {:else}
            Make this user an administrator so they can manage users and resources.
          {/if}
        </p>
      </div>
      {#if !isSelf}
        <button
          type="button"
          class={user.role === 'admin' ? 'danger-button' : ''}
          on:click={() => { roleDialogOpen = true; roleError = ''; success = '' }}
        >
          {user.role === 'admin' ? 'Remove admin' : 'Make admin'}
        </button>
      {/if}
    </div>

    {#if roleDialogOpen}
      <ConfirmDialog
        eyebrow="Change role"
        title={user.role === 'admin' ? `Remove admin from ${user.username}?` : `Make ${user.username} an admin?`}
        confirmLabel={user.role === 'admin' ? 'Remove admin' : 'Make admin'}
        busyLabel="Saving…"
        danger={user.role === 'admin'}
        busy={roleSaving}
        error={roleError}
        onConfirm={toggleAdmin}
        onCancel={() => { if (!roleSaving) roleDialogOpen = false }}
      >
        {#if user.role === 'admin'}
          <p><strong>{user.username}</strong> will lose access to the admin panel and become a student.</p>
        {:else}
          <p>
            <strong>{user.username}</strong> will be able to create, edit, ban and delete users, and delete resources.
            Only do this for people you trust.
          </p>
        {/if}
      </ConfirmDialog>
    {/if}

    <div class="panel account-danger-zone">
      <div>
        <h3>{user.isBanned ? 'Account banned' : 'Ban account'}</h3>
        <p class="muted">
          {#if isSelf}
            You can't ban your own account.
          {:else if user.isBanned}
            This user can only view their profile and delete their account. Unbanning restores full access.
          {:else}
            A banned user can only view their profile and delete their account. Existing reservations are kept.
          {/if}
        </p>
      </div>
      {#if !isSelf}
        <button
          type="button"
          class={user.isBanned ? 'secondary-button' : 'danger-button'}
          on:click={() => { confirmingBan = true; banError = ''; success = '' }}
        >
          {user.isBanned ? 'Unban user' : 'Ban user'}
        </button>
      {/if}
    </div>

    {#if confirmingBan}
      <ConfirmDialog
        eyebrow={user.isBanned ? 'Restore access' : 'Restrict access'}
        title={user.isBanned ? `Unban ${user.username}?` : `Ban ${user.username}?`}
        confirmLabel={user.isBanned ? 'Unban user' : 'Ban user'}
        busyLabel="Saving…"
        danger={!user.isBanned}
        busy={saving}
        error={banError}
        onConfirm={() => setBanned(!user!.isBanned)}
        onCancel={() => { if (!saving) confirmingBan = false }}
      >
        {#if user.isBanned}
          <p>Unbanning <strong>{user.username}</strong> restores their full access to CampusConnect.</p>
        {:else}
          <p>
            <strong>{user.username}</strong> will only be able to view their profile and delete their account.
            Their existing reservations are kept. You can unban them at any time.
          </p>
        {/if}
      </ConfirmDialog>
    {/if}
    {#if !isSelf}
      <div class="panel account-danger-zone">
        <div>
          <h3>Delete account</h3>
          <p class="muted">
            Removes the user's password, sessions, notifications, reviews and profile image, and blocks sign-in.
            Reservation history and their listed resources are kept.
          </p>
          {#if deleteOpen}
            {#if deleteError}
              <p class="notice error-notice" role="alert">{deleteError}</p>
            {/if}
            <form class="admin-form" on:submit|preventDefault={deleteAccount}>
              <label>
                Type <strong>{user.username}</strong> to confirm
                <input bind:value={deleteConfirm} autocomplete="off" required />
              </label>
              <div class="password-actions">
                <button type="submit" class="danger-button" disabled={deleting || deleteConfirm !== user.username}>
                  {deleting ? 'Deleting…' : 'Permanently delete account'}
                </button>
                <button
                  type="button"
                  class="secondary-button"
                  disabled={deleting}
                  on:click={() => { deleteOpen = false; deleteConfirm = ''; deleteError = '' }}
                >
                  Cancel
                </button>
              </div>
            </form>
          {/if}
        </div>
        {#if !deleteOpen}
          <button type="button" class="danger-button" on:click={() => (deleteOpen = true)}>Delete account</button>
        {/if}
      </div>
    {/if}
  {:else if error}
    <p class="notice error-notice" role="alert">{error}</p>
  {/if}
</section>
