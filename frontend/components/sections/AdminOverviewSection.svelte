<script lang="ts">
  import { onMount } from 'svelte'
  import { getJson } from '../../lib/api'
  import { adminHash } from '../../lib/adminRoutes'
  import type { AdminStats } from '../../lib/types'

  let stats: AdminStats | null = null
  let loading = true
  let error = ''

  onMount(async () => {
    try {
      stats = (await getJson<{ stats: AdminStats }>('/api/admin/stats')).stats
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Unable to load statistics.'
    } finally {
      loading = false
    }
  })

  const ROLE_ORDER = ['admin', 'staff', 'student']
  const STATUS_ORDER = ['confirmed', 'active', 'completed', 'cancelled']
</script>

<section class="admin-page">
  <header class="page-heading">
    <p class="eyebrow">Administration</p>
    <h2>Overview</h2>
    <p class="muted">A snapshot of CampusConnect.</p>
  </header>

  {#if loading}
    <div class="panel"><p class="muted">Loading statistics…</p></div>
  {:else if error}
    <p class="notice error-notice" role="alert">{error}</p>
  {:else if stats}
    <div class="stat-grid">
      <a class="panel stat-card" href={adminHash('users')}>
        <span class="stat-value">{stats.users.total}</span>
        <span class="stat-label">Registered users</span>
      </a>
      <a class="panel stat-card" href={adminHash('resources')}>
        <span class="stat-value">{stats.resources.total}</span>
        <span class="stat-label">Resources</span>
      </a>
      <a class="panel stat-card" href={adminHash('reservations')}>
        <span class="stat-value">{stats.reservations.total}</span>
        <span class="stat-label">Reservations</span>
      </a>
    </div>

    <div class="admin-columns">
      <section class="panel">
        <h3>Accounts</h3>
        <dl class="profile-details">
          <div><dt>Verified</dt><dd>{stats.users.verified}</dd></div>
          <div><dt>Awaiting verification</dt><dd>{stats.users.unverified}</dd></div>
          <div><dt>Banned</dt><dd>{stats.users.banned}</dd></div>
          {#each ROLE_ORDER as role}
            <div><dt>{role[0].toUpperCase() + role.slice(1)}s</dt><dd>{stats.users.byRole[role] ?? 0}</dd></div>
          {/each}
        </dl>
      </section>

      <section class="panel">
        <h3>Reservations by status</h3>
        <dl class="profile-details">
          {#each STATUS_ORDER as status}
            <div><dt>{status[0].toUpperCase() + status.slice(1)}</dt><dd>{stats.reservations.byStatus[status] ?? 0}</dd></div>
          {/each}
        </dl>
      </section>
    </div>
  {/if}
</section>
