<script lang="ts">
  import type { PublicUser } from '../../lib/types'

  export let user: PublicUser
  export let submitting: boolean
  export let onLogout: () => void

  let changeOpen = false
  let currentPassword = ''
  let newPassword = ''
  let confirmPassword = ''
  let saving = false
  let error = ''
  let success = ''
  let fieldErrors: Record<string, string> = {}

  function toggleChange() {
    changeOpen = !changeOpen
    resetForm()
    success = ''
  }

  function resetForm() {
    currentPassword = ''
    newPassword = ''
    confirmPassword = ''
    error = ''
    fieldErrors = {}
  }

  async function changePassword() {
    error = ''
    success = ''
    fieldErrors = {}
    saving = true

    try {
      const response = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
      })
      const payload = await response.json().catch(() => ({})) as {
        error?: string
        message?: string
        fieldErrors?: Record<string, string>
      }

      if (!response.ok) {
        error = payload.error ?? 'Unable to change your password.'
        fieldErrors = payload.fieldErrors ?? {}
        return
      }

      success = payload.message ?? 'Your password has been updated.'
      changeOpen = false
      resetForm()
    } catch {
      error = 'Unable to connect to CampusConnect.'
    } finally {
      saving = false
    }
  }
</script>

<section class="panel profile-card">
  <div class="profile-heading">
    <div>
      <p class="eyebrow">Profile details</p>
      <h2>{user.username}</h2>
      <p class="muted">Your CampusConnect account information.</p>
    </div>
    <button type="button" class="secondary-button" on:click={onLogout} disabled={submitting}>
      {submitting ? 'Signing out…' : 'Sign out'}
    </button>
  </div>

  <dl class="profile-details">
    <div><dt>Username</dt><dd>{user.username}</dd></div>
    <div><dt>Email</dt><dd>{user.email}</dd></div>
    <div><dt>Phone</dt><dd>{user.phoneNumber ?? 'Not provided'}</dd></div>
    <div><dt>Account type</dt><dd>{user.role}</dd></div>
    <div><dt>Credits</dt><dd>{user.creditBalance}</dd></div>
    <div><dt>Joined</dt><dd>{new Date(user.createdAt).toLocaleDateString()}</dd></div>
    <div><dt>Email notifications</dt><dd>{user.emailNotificationsOn ? 'On' : 'Off'}</dd></div>
    <div><dt>SMS notifications</dt><dd>{user.textNotificationsOn ? 'On' : 'Off'}</dd></div>
  </dl>

  <div class="password-section">
    {#if success}
      <p class="notice success-notice" role="status">{success}</p>
    {/if}

    {#if !changeOpen}
      <button type="button" class="secondary-button" on:click={toggleChange}>Change password</button>
    {:else}
      <h3>Change password</h3>
      {#if error}
        <p class="notice error-notice" role="alert">{error}</p>
      {/if}
      <form on:submit|preventDefault={changePassword}>
        <label>
          Current password
          <input type="password" bind:value={currentPassword} autocomplete="current-password" required />
          {#if fieldErrors.currentPassword}<span class="field-error">{fieldErrors.currentPassword}</span>{/if}
        </label>
        <label>
          New password
          <input type="password" bind:value={newPassword} autocomplete="new-password" minlength="8" maxlength="128" required />
          {#if fieldErrors.newPassword}<span class="field-error">{fieldErrors.newPassword}</span>{/if}
        </label>
        <label>
          Confirm new password
          <input type="password" bind:value={confirmPassword} autocomplete="new-password" required />
          {#if fieldErrors.confirmPassword}<span class="field-error">{fieldErrors.confirmPassword}</span>{/if}
        </label>
        <div class="password-actions">
          <button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Update password'}</button>
          <button type="button" class="secondary-button" on:click={toggleChange} disabled={saving}>Cancel</button>
        </div>
      </form>
    {/if}
  </div>
</section>
