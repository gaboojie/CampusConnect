<script lang="ts">
  import { routeHash, type RouteId } from '../lib/routes'

  type NavItem = { id: string; label: string; icon: string[] }

  export let routes: NavItem[]
  export let currentId: string
  export let hrefFor: (id: string) => string = (id) => routeHash(id as RouteId)
  export let collapsed: boolean
  export let onToggle: () => void
  export let onNavigate: () => void
</script>

<nav id="app-sidebar" class="sidebar" aria-label="Main navigation">
  <button
    type="button"
    class="sidebar-toggle"
    aria-controls="app-sidebar"
    aria-expanded={!collapsed}
    title={collapsed ? 'Expand sidebar' : undefined}
    on:click={onToggle}
  >
    <svg class="nav-icon toggle-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14.5 6.5 9 12l5.5 5.5" />
    </svg>
    <span class="sidebar-label">{collapsed ? 'Expand sidebar' : 'Collapse sidebar'}</span>
  </button>

  <ul class="sidebar-list">
    {#each routes as route (route.id)}
      <li>
        <a
          class="sidebar-link"
          class:active={route.id === currentId}
          href={hrefFor(route.id)}
          aria-current={route.id === currentId ? 'page' : undefined}
          title={collapsed ? route.label : undefined}
          on:click={onNavigate}
        >
          <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
            {#each route.icon as d}<path {d} />{/each}
          </svg>
          <span class="sidebar-label">{route.label}</span>
        </a>
      </li>
    {/each}
  </ul>
</nav>
