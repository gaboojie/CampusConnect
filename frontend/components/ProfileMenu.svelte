<script lang="ts">
  import { isAdminPath } from '../lib/adminRoutes'
  import { routeHash } from '../lib/routes'
  import type { PublicUser } from '../lib/types'

  export let user: PublicUser
  export let submitting = false
  export let onLogout: () => void

  let open = false
  const onAdminPath = isAdminPath(window.location.pathname)
  let root: HTMLDivElement

  function close() {
    open = false
  }

  function openProfile() {
    close()

    if (isAdminPath(window.location.pathname)) {
      window.location.assign(`/${routeHash('profile')}`)
    } else {
      window.location.hash = routeHash('profile')
    }
  }

  function signOut() {
    close()
    onLogout()
  }

  function handleWindowClick(event: MouseEvent) {
    if (open && root && !root.contains(event.target as Node)) close()
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && open) close()
  }
</script>

<svelte:window on:click={handleWindowClick} on:keydown={handleKeydown} />

<div class="profile-menu" bind:this={root}>
  <button
    type="button"
    class="account-indicator profile-menu-trigger"
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={`Account menu for ${user.username}`}
    on:click={() => open = !open}
  >
    {#if user.profileImageUrl}
      <img class="user-icon account-avatar" src={user.profileImageUrl} alt="" />
    {:else}
      <svg class="user-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="8" r="3.25" fill="none" stroke="currentColor" stroke-width="1.8" />
        <path d="M5.5 20c.7-3.7 2.9-5.5 6.5-5.5s5.8 1.8 6.5 5.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.8" />
      </svg>
    {/if}
    <span>{user.username}</span>
  </button>

  {#if open}
    <div class="profile-menu-list" role="menu">
      <button type="button" role="menuitem" on:click={openProfile}>
        <svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 4.75a3.25 3.25 0 1 1 0 6.5a3.25 3.25 0 1 1 0-6.5Z" />
          <path d="M5.5 20c.7-3.7 2.9-5.5 6.5-5.5s5.8 1.8 6.5 5.5" />
        </svg>
        Profile details
      </button>
      {#if user.role === 'admin' && !onAdminPath}
        <a class="menu-link" role="menuitem" href="/admin" on:click={close}>
          <svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3.5 5 6.5v5c0 4.2 2.8 7.4 7 9 4.2-1.6 7-4.8 7-9v-5Z" />
            <path d="m9 12 2.2 2.2L15.2 10" />
          </svg>
          Admin panel
        </a>
      {:else if onAdminPath}
        <a class="menu-link" role="menuitem" href="/" on:click={close}>
          <svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M14.5 6.5 9 12l5.5 5.5" />
          </svg>
          Back to CampusConnect
        </a>
      {/if}
      <div class="menu-divider" role="separator"></div>
      <button type="button" role="menuitem" class="menu-danger" disabled={submitting} on:click={signOut}>
        <svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M10 5H5.5v14H10" />
          <path d="M14 8.5 18 12l-4 3.5" />
          <path d="M18 12H9.5" />
        </svg>
        {submitting ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  {/if}
</div>
