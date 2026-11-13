<script lang="ts">
  import { ApiError, sendJson } from '../lib/api'
  import type { AdminUserDetail } from '../lib/types'

  export let onCreated: (user: AdminUserDetail) => void
  export let onCancel: () => void

  let username = ''
  let email = ''
  let password = ''
  let role = 'student'
  let canAddResources = true
  let emailNotificationsOn = true
  let saving = false
  let error = ''
  let fieldErrors: Record<string, string> = {}

  async function submit() {
    saving = true
    error = ''
    fieldErrors = {}

    try {
      const { user } = await sendJson<{ user: AdminUserDetail }>('POST', '/api/admin/users', {
        username,
        email,
        password,
        role,
        canAddResources,
        emailNotificationsOn,
      })
      onCreated(user)
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Unable to create this user.'
      if (caught instanceof ApiError) fieldErrors = caught.fieldErrors
    } finally {
      saving = false
    }
  }
</script>

<form class="panel admin-form" on:submit|preventDefault={submit}>
  <div>
    <h3>Create user</h3>
    <p class="muted">The account is verified immediately and starts with 20 credits. Share the password with the user securely.</p>
  </div>

  {#if error}
    <p class="notice error-notice" role="alert">{error}</p>
  {/if}

  <div class="admin-form-grid">
    <label>
      Username
      <input bind:value={username} autocomplete="off" minlength="3" maxlength="32" required />
      {#if fieldErrors.username}<span class="field-error">{fieldErrors.username}</span>{/if}
    </label>
    <label>
      Virginia Tech email
      <input type="email" bind:value={email} autocomplete="off" placeholder="name@vt.edu" required />
      {#if fieldErrors.email}<span class="field-error">{fieldErrors.email}</span>{/if}
    </label>
    <label>
      Temporary password
      <input type="password" bind:value={password} autocomplete="new-password" minlength="8" maxlength="128" required />
      {#if fieldErrors.password}<span class="field-error">{fieldErrors.password}</span>{/if}
    </label>
    <label>
      Role
      <select bind:value={role}>
        <option value="student">Student</option>
        <option value="staff">Staff</option>
        <option value="admin">Admin</option>
      </select>
      {#if fieldErrors.role}<span class="field-error">{fieldErrors.role}</span>{/if}
    </label>
  </div>

  <label class="checkbox-label">
    <input type="checkbox" bind:checked={canAddResources} />
    Can list resources
  </label>
  <label class="checkbox-label">
    <input type="checkbox" bind:checked={emailNotificationsOn} />
    Email notifications on
  </label>

  <div class="password-actions">
    <button type="submit" disabled={saving}>{saving ? 'Creating…' : 'Create user'}</button>
    <button type="button" class="secondary-button" disabled={saving} on:click={onCancel}>Cancel</button>
  </div>
</form>
