<script lang="ts">
  import { onMount } from 'svelte'
  import Sidebar from './Sidebar.svelte'
  import AdminOverviewSection from './sections/AdminOverviewSection.svelte'
  import AdminReservationsSection from './sections/AdminReservationsSection.svelte'
  import AdminUserDetailSection from './sections/AdminUserDetailSection.svelte'
  import AdminUsersSection from './sections/AdminUsersSection.svelte'
  import PlaceholderSection from './sections/PlaceholderSection.svelte'
  import {
    DEFAULT_ADMIN_ROUTE,
    adminHash,
    adminLocationHash,
    adminRoutes,
    parseAdminLocation,
    type AdminLocation,
  } from '../lib/adminRoutes'
  import type { PublicUser } from '../lib/types'

  export let user: PublicUser

  const COLLAPSED_STORAGE_KEY = 'campusconnect.sidebarCollapsed'

  let location: AdminLocation = { route: DEFAULT_ADMIN_ROUTE, subpath: null }
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
      // Storage can be unavailable; keep the in-memory choice.
    }
  }

  function closeDrawer() {
    drawerOpen = false
  }

  function syncRoute() {
    const previous = location
    location = parseAdminLocation(window.location.hash)
    drawerOpen = false

    if (previous.route.id !== location.route.id || previous.subpath !== location.subpath) {
      window.scrollTo({ top: 0 })
    }

    const expectedHash = adminLocationHash(location)
    if (window.location.hash !== expectedHash) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${expectedHash}`)
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && drawerOpen) closeDrawer()
  }

  onMount(syncRoute)

  $: route = location.route
</script>

<svelte:window on:hashchange={syncRoute} on:keydown={handleKeydown} />

{#if user.role !== 'admin'}
  <section class="panel pending">
    <p class="eyebrow">Restricted</p>
    <h2>Administrator access required</h2>
    <p class="muted">Your account does not have access to the admin panel.</p>
    <a class="button-link" href="/">Back to CampusConnect</a>
  </section>
{:else}
  <div class="app-layout" class:sidebar-collapsed={collapsed} class:drawer-open={drawerOpen}>
    <Sidebar
      routes={adminRoutes}
      currentId={route.id}
      hrefFor={adminHash}
      {collapsed}
      onToggle={toggleCollapsed}
      onNavigate={closeDrawer}
    />

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

      {#if route.id === 'users' && location.subpath}
        {#key location.subpath}
          <AdminUserDetailSection userId={location.subpath} />
        {/key}
      {:else if route.id === 'users'}
        <AdminUsersSection />
      {:else if route.id === 'reservations'}
        <AdminReservationsSection />
      {:else if route.id === 'resources'}
        <PlaceholderSection {route} />
      {:else}
        <AdminOverviewSection />
      {/if}
    </div>
  </div>
{/if}
