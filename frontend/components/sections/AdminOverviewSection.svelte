<script lang="ts">
  import { onMount } from 'svelte'
  import { getJson } from '../../lib/api'
  import { adminHash } from '../../lib/adminRoutes'
  import type { AdminStats } from '../../lib/types'
  import AdminActivityChart from '../AdminActivityChart.svelte'
  import BarList from '../BarList.svelte'
  import PieChart from '../PieChart.svelte'

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
  const STATUS_COLORS: Record<string, string> = {
    confirmed: '#3b6fb6',
    active: '#2f8f6b',
    completed: '#7b8794',
    cancelled: '#c04a4a',
  }
  const ROLE_COLORS: Record<string, string> = { admin: '#630031', staff: '#e5751f', student: '#3b6fb6' }
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

    <section class="panel chart-panel">
      <h3>Last {stats.activity.length} days</h3>
      <p class="muted">Bookings made and new accounts per day.</p>
      <AdminActivityChart data={stats.activity} />
    </section>

    <div class="admin-columns">
      <section class="panel">
        <h3>Reservations by status</h3>
        <PieChart
          label="Reservations by status"
          items={STATUS_ORDER.map((status) => ({
            label: status[0].toUpperCase() + status.slice(1),
            value: stats?.reservations.byStatus[status] ?? 0,
            color: STATUS_COLORS[status],
          }))}
        />
      </section>

      <section class="panel">
        <h3>Users by role</h3>
        <PieChart
          label="Users by role"
          items={ROLE_ORDER.map((role) => ({
            label: role[0].toUpperCase() + role.slice(1) + 's',
            value: stats?.users.byRole[role] ?? 0,
            color: ROLE_COLORS[role],
          }))}
        />
      </section>

      <section class="panel">
        <h3>Account health</h3>
        <BarList
          items={[
            { label: 'Verified', value: stats.users.verified, color: '#2f8f6b' },
            { label: 'Awaiting verification', value: stats.users.unverified, color: '#d9a21b' },
            { label: 'Banned', value: stats.users.banned, color: '#c04a4a' },
          ]}
        />
      </section>
    </div>
  {/if}
</section>
