<script lang="ts">
  import { sendForm, sendJson } from '../../lib/api'
  import type { PublicUser } from '../../lib/types'

  export let user: PublicUser
  export let submitting: boolean
  export let onLogout: () => void
  export let onAccountDeleted: () => void
  export let onUserUpdated: (user: PublicUser) => void

  type EditableField = 'username' | 'profileImage' | 'emailNotifications' | 'textNotifications' | 'password' | null

  let editing: EditableField = null
  let saving = false
  let error = ''
  let success = ''
  let fieldErrors: Record<string, string> = {}

  let usernameDraft = ''
  let emailNotificationsDraft = false
  let textNotificationsDraft = false
  let selectedImage: File | null = null
  let imageInput: HTMLInputElement

  let currentPassword = ''
  let newPassword = ''
  let confirmPassword = ''

  let deleteOpen = false
  let deleteUsername = ''
  let deleteError = ''
  let deleting = false

  function clearFeedback() {
    error = ''
    success = ''
    fieldErrors = {}
  }

  function startEditing(field: Exclude<EditableField, null>) {
    clearFeedback()
    editing = field
    if (field === 'username') usernameDraft = user.username
    if (field === 'emailNotifications') emailNotificationsDraft = user.emailNotificationsOn
    if (field === 'textNotifications') textNotificationsDraft = user.textNotificationsOn
    if (field === 'profileImage') selectedImage = null
    if (field === 'password') {
      currentPassword = ''
      newPassword = ''
      confirmPassword = ''
    }
  }

  function cancelEditing() {
    if (!saving) {
      editing = null
      selectedImage = null
      clearFeedback()
    }
  }

  function applyUpdatedUser(updated: PublicUser, message: string) {
    onUserUpdated(updated)
    editing = null
    selectedImage = null
    success = message
  }

  async function saveUsername() {
    clearFeedback()
    saving = true
    try {
      const payload = await sendJson<{ user: PublicUser; message: string }>('PATCH', '/api/profile/username', { username: usernameDraft })
      applyUpdatedUser(payload.user, payload.message)
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Unable to update your username.'
    } finally {
      saving = false
    }
  }

  async function saveNotifications() {
    clearFeedback()
    saving = true
    try {
      const payload = await sendJson<{ user: PublicUser; message: string }>('PATCH', '/api/profile/notifications', {
        emailNotificationsOn: emailNotificationsDraft,
        textNotificationsOn: textNotificationsDraft,
      })
      applyUpdatedUser(payload.user, payload.message)
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Unable to update notification settings.'
    } finally {
      saving = false
    }
  }

  function selectImage(event: Event) {
    selectedImage = (event.currentTarget as HTMLInputElement).files?.[0] ?? null
  }

  async function saveProfileImage(removeImage = false) {
    clearFeedback()
    saving = true
    const form = new FormData()
    if (selectedImage) form.append('image', selectedImage)
    if (removeImage) form.append('removeImage', 'true')

    try {
      const payload = await sendForm<{ user: PublicUser; message: string }>('PATCH', '/api/profile/image', form)
      applyUpdatedUser(payload.user, payload.message)
      if (imageInput) imageInput.value = ''
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Unable to update your profile image.'
    } finally {
      saving = false
    }
  }

  async function changePassword() {
    clearFeedback()
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
      editing = null
      currentPassword = ''
      newPassword = ''
      confirmPassword = ''
      success = payload.message ?? 'Your password has been updated.'
    } catch {
      error = 'Unable to connect to CampusConnect.'
    } finally {
      saving = false
    }
  }

  function openDelete() {
    clearFeedback()
    deleteUsername = ''
    deleteError = ''
    deleteOpen = true
  }

  function closeDelete() {
    if (!deleting) deleteOpen = false
  }

  async function deleteAccount() {
    deleteError = ''
    deleting = true
    try {
      await sendJson('DELETE', '/api/auth/delete-account', { username: deleteUsername })
      deleteOpen = false
      onAccountDeleted()
    } catch (caught) {
      deleteError = caught instanceof Error ? caught.message : 'Unable to delete your account.'
    } finally {
      deleting = false
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && deleteOpen) closeDelete()
  }

  function accountTypeLabel(role: string): string {
    if (role === 'student' || role === 'user') return 'Standard user'
    return role.charAt(0).toUpperCase() + role.slice(1)
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<section class="panel profile-card">
  {#if user.role !== 'admin' && (user.isBanned || !user.canAddResources)}
    <div class="profile-alert-stack" aria-label="Account warnings">
      {#if user.isBanned}
        <div class="profile-warning" role="alert"><span class="warning-icon" aria-hidden="true">!</span><div><strong>Your account is banned.</strong><span>You can view this page or delete your account. Other CampusConnect features are unavailable.</span></div></div>
      {/if}
      {#if !user.isBanned && !user.canAddResources}
        <div class="profile-warning" role="status"><span class="warning-icon" aria-hidden="true">!</span><div><strong>Your ability to add resources has been restricted.</strong><span>An administrator flagged activity on your account as malicious, so you can no longer add resources.</span></div></div>
      {/if}
    </div>
  {/if}

  <div class="profile-heading">
    <div><p class="eyebrow">Profile details</p><h2>{user.username}</h2><p class="muted">Your CampusConnect account information.</p></div>
    <button type="button" class="secondary-button" on:click={onLogout} disabled={submitting}>{submitting ? 'Signing out…' : 'Sign out'}</button>
  </div>

  {#if error}<p class="notice error-notice" role="alert">{error}</p>{/if}
  {#if success}<p class="notice success-notice" role="status">{success}</p>{/if}

  <div class="profile-identity">
    {#if user.profileImageUrl}<img class="profile-avatar" src={user.profileImageUrl} alt="" />
    {:else}<div class="profile-avatar profile-avatar-placeholder" aria-label="No profile image"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.75a3.25 3.25 0 1 1 0 6.5a3.25 3.25 0 1 1 0-6.5Z" /><path d="M5.5 20c.7-3.7 2.9-5.5 6.5-5.5s5.8 1.8 6.5 5.5" /></svg></div>{/if}
    <div class="profile-identity-copy"><strong>Profile image</strong><span class="muted">{user.profileImageUrl ? 'Your current profile image' : 'No profile image set'}</span></div>
    {#if !user.isBanned || user.role === 'admin'}<button type="button" class="icon-button" aria-label="Edit profile image" title="Edit profile image" on:click={() => startEditing('profileImage')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16.5-.75 3.75L7 19.5 18.25 8.25a2.12 2.12 0 0 0-3-3L4 16.5Z" /><path d="m13.75 6.75 3.5 3.5" /></svg></button>{/if}
  </div>

  {#if editing === 'profileImage'}
    <div class="profile-inline-editor">
      <label>Choose an image<input bind:this={imageInput} type="file" accept="image/jpeg,image/png,image/webp" on:change={selectImage} /></label>
      <p class="form-help">JPEG, PNG, or WebP up to 1 MB.</p>
      <div class="password-actions"><button type="button" on:click={() => saveProfileImage()} disabled={saving || !selectedImage}>{saving ? 'Saving…' : 'Save image'}</button>{#if user.profileImageUrl}<button type="button" class="secondary-button" on:click={() => saveProfileImage(true)} disabled={saving}>Remove image</button>{/if}<button type="button" class="secondary-button" on:click={cancelEditing} disabled={saving}>Cancel</button></div>
    </div>
  {/if}

  <dl class="profile-details">
    <div class="profile-detail-row"><dt>Username</dt>{#if editing === 'username'}<dd class="profile-edit-value"><input bind:value={usernameDraft} minlength="3" maxlength="32" autocomplete="username" /><span class="profile-edit-actions"><button type="button" class="compact-button" on:click={saveUsername} disabled={saving}>Save</button><button type="button" class="secondary-button compact-button" on:click={cancelEditing} disabled={saving}>Cancel</button></span></dd>{:else}<dd>{user.username}</dd>{/if}{#if (!user.isBanned || user.role === 'admin') && editing !== 'username'}<button type="button" class="icon-button detail-edit" aria-label="Edit username" title="Edit username" on:click={() => startEditing('username')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16.5-.75 3.75L7 19.5 18.25 8.25a2.12 2.12 0 0 0-3-3L4 16.5Z" /><path d="m13.75 6.75 3.5 3.5" /></svg></button>{/if}</div>
    <div><dt>Email</dt><dd>{user.email}</dd></div>
    <div><dt>Phone</dt><dd>{user.phoneNumber ?? 'Not provided'}</dd></div>
    <div><dt>Account type</dt><dd>{accountTypeLabel(user.role)}</dd></div>
    <div><dt>Credits</dt><dd>{user.creditBalance}</dd></div>
    <div><dt>Joined</dt><dd>{new Date(user.createdAt).toLocaleDateString()}</dd></div>
    <div class="profile-detail-row"><dt>Email notifications</dt>{#if editing === 'emailNotifications'}<dd class="profile-edit-value"><label class="toggle-label"><input class="toggle-input" type="checkbox" bind:checked={emailNotificationsDraft} /><span class="toggle-track" aria-hidden="true"><span class="toggle-thumb"></span></span><span>Receive email notifications</span></label><span class="profile-edit-actions"><button type="button" class="compact-button" on:click={saveNotifications} disabled={saving}>Save</button><button type="button" class="secondary-button compact-button" on:click={cancelEditing} disabled={saving}>Cancel</button></span></dd>{:else}<dd>{user.emailNotificationsOn ? 'On' : 'Off'}</dd>{/if}{#if (!user.isBanned || user.role === 'admin') && editing !== 'emailNotifications'}<button type="button" class="icon-button detail-edit" aria-label="Edit email notifications" title="Edit email notifications" on:click={() => startEditing('emailNotifications')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16.5-.75 3.75L7 19.5 18.25 8.25a2.12 2.12 0 0 0-3-3L4 16.5Z" /><path d="m13.75 6.75 3.5 3.5" /></svg></button>{/if}</div>
    <div class="profile-detail-row"><dt>SMS notifications</dt>{#if editing === 'textNotifications'}<dd class="profile-edit-value"><label class="toggle-label"><input class="toggle-input" type="checkbox" bind:checked={textNotificationsDraft} disabled={!user.phoneNumber} /><span class="toggle-track" aria-hidden="true"><span class="toggle-thumb"></span></span><span>Receive SMS notifications</span></label>{#if !user.phoneNumber}<span class="form-help">Add a phone number before enabling SMS notifications.</span>{/if}<span class="profile-edit-actions"><button type="button" class="compact-button" on:click={saveNotifications} disabled={saving}>Save</button><button type="button" class="secondary-button compact-button" on:click={cancelEditing} disabled={saving}>Cancel</button></span></dd>{:else}<dd>{user.textNotificationsOn ? 'On' : 'Off'}</dd>{/if}{#if (!user.isBanned || user.role === 'admin') && editing !== 'textNotifications'}<button type="button" class="icon-button detail-edit" aria-label="Edit SMS notifications" title="Edit SMS notifications" on:click={() => startEditing('textNotifications')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16.5-.75 3.75L7 19.5 18.25 8.25a2.12 2.12 0 0 0-3-3L4 16.5Z" /><path d="m13.75 6.75 3.5 3.5" /></svg></button>{/if}</div>
  </dl>

  {#if !user.isBanned || user.role === 'admin'}
    <div class="password-section"><div class="section-heading-row"><div><h3>Password</h3><p class="muted">Use your current password to choose a new one.</p></div>{#if editing !== 'password'}<button type="button" class="icon-button" aria-label="Edit password" title="Edit password" on:click={() => startEditing('password')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16.5-.75 3.75L7 19.5 18.25 8.25a2.12 2.12 0 0 0-3-3L4 16.5Z" /><path d="m13.75 6.75 3.5 3.5" /></svg></button>{/if}</div>{#if editing === 'password'}<form on:submit|preventDefault={changePassword}><label>Current password<input type="password" bind:value={currentPassword} autocomplete="current-password" required />{#if fieldErrors.currentPassword}<span class="field-error">{fieldErrors.currentPassword}</span>{/if}</label><label>New password<input type="password" bind:value={newPassword} autocomplete="new-password" minlength="8" maxlength="128" required />{#if fieldErrors.newPassword}<span class="field-error">{fieldErrors.newPassword}</span>{/if}</label><label>Confirm new password<input type="password" bind:value={confirmPassword} autocomplete="new-password" required />{#if fieldErrors.confirmPassword}<span class="field-error">{fieldErrors.confirmPassword}</span>{/if}</label><div class="password-actions"><button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Update password'}</button><button type="button" class="secondary-button" on:click={cancelEditing} disabled={saving}>Cancel</button></div></form>{/if}</div>
  {/if}

  <div class="account-danger-zone"><div><h3>Delete account</h3><p class="muted">Permanently remove your CampusConnect account and personal profile data.</p></div><button type="button" class="danger-button" on:click={openDelete}>Delete account</button></div>
</section>

{#if deleteOpen}
  <div class="modal-layer"><button type="button" class="modal-backdrop" aria-label="Close delete account dialog" on:click={closeDelete}></button><dialog open class="modal delete-account-modal" aria-labelledby="delete-account-title"><div class="modal-heading"><div><p class="eyebrow">This cannot be undone</p><h2 id="delete-account-title">Delete your account?</h2></div><button type="button" class="modal-close" aria-label="Close delete account dialog" on:click={closeDelete}>×</button></div><p><strong>Your account will be permanently deleted.</strong> You will not be able to regain access to it afterwards.</p><p>Deleting your account removes your profile information, password, notification settings, profile image, notifications, and reviews. Your reservation history may be retained without identifying profile information.</p><p class="safety-note">Please return any reservations, equipment, keys, or other items before deleting your account.</p>{#if deleteError}<p class="notice error-notice" role="alert">{deleteError}</p>{/if}<form on:submit|preventDefault={deleteAccount}><label>Type <strong>{user.username}</strong> to confirm<input bind:value={deleteUsername} autocomplete="off" required /></label><div class="password-actions"><button type="submit" class="danger-button" disabled={deleting || deleteUsername !== user.username}>{deleting ? 'Deleting…' : 'Permanently delete account'}</button><button type="button" class="secondary-button" on:click={closeDelete} disabled={deleting}>Cancel</button></div></form></dialog></div>
{/if}
