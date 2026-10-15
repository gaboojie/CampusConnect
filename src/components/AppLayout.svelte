<script lang="ts">
  import { onMount } from 'svelte'
  import Sidebar from './Sidebar.svelte'
  import AnnouncementsSection from './sections/AnnouncementsSection.svelte'
  import PlaceholderSection from './sections/PlaceholderSection.svelte'
  import ProfileSection from './sections/ProfileSection.svelte'
  import ResourceDetailSection from './sections/ResourceDetailSection.svelte'
  import ResourcesSection from './sections/ResourcesSection.svelte'
  import { DEFAULT_ROUTE, locationHash, parseLocation, routes, type AppLocation } from '../lib/routes'
  import type { PublicUser } from '../lib/types'

  export let user: PublicUser
  export let submitting: boolean
  export let onLogout: () => void

  const COLLAPSED_STORAGE_KEY = 'campusconnect.sidebarCollapsed'

  let location: AppLocation = { route: DEFAULT_ROUTE, subpath: null, query: '' }
  let collapsed = readCollapsed()
  let drawerOpen = false

  function readCollapsed(): boolean {
    try {
      return localStorage.getItem(COLLAPSED_STORAGE_KEY) === 'true'
    } catch {
      return false
    }
  }

  function toggleCollapsed() {
    collapsed = !collapsed

    try {
      localStorage.setItem(COLLAPSED_STORAGE_KEY, String(collapsed))
    } catch {
      // Storage can be unavailable (private mode, blocked site data); keep the in-memory choice.
    }
  }

  function closeDrawer() {
    drawerOpen = false
  }

  function syncRoute() {
    const previous = location
    location = parseLocation(window.location.hash)
    drawerOpen = false

    // Moving between pages (not just filter changes) starts at the top.
    if (previous.route.id !== location.route.id || previous.subpath !== location.subpath) {
      window.scrollTo({ top: 0 })
    }

    const expectedHash = locationHash(location)
    if (window.location.hash !== expectedHash) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${expectedHash}`)
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && drawerOpen) {
      closeDrawer()
    }
  }

  onMount(syncRoute)

  $: route = location.route
</script>

<svelte:window on:hashchange={syncRoute} on:keydown={handleKeydown} />

<div class="app-layout" class:sidebar-collapsed={collapsed} class:drawer-open={drawerOpen}>
  <Sidebar {routes} currentId={route.id} {collapsed} onToggle={toggleCollapsed} onNavigate={closeDrawer} />

  {#if drawerOpen}
    <button type="button" class="drawer-backdrop" aria-label="Close navigation" on:click={closeDrawer}></button>
  {/if}

  <div class="app-main">
    <div class="mobile-bar">
      <button
        type="button"
        class="secondary-button menu-button"
        aria-controls="app-sidebar"
        aria-expanded={drawerOpen}
        on:click={() => drawerOpen = true}
      >
        <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
        Menu
      </button>
      <span class="mobile-bar-title">{route.label}</span>
    </div>

    {#if route.id === 'profile'}
      <ProfileSection {user} {submitting} {onLogout} />
    {:else if route.id === 'resources' && location.subpath}
      <ResourceDetailSection resourceId={location.subpath} backQuery={location.query} />
    {:else if route.id === 'resources'}
      <ResourcesSection query={location.query} />
    {:else if route.id === 'announcements'}
      <AnnouncementsSection />
    {:else}
      <PlaceholderSection {route} />
    {/if}
  </div>
</div>
