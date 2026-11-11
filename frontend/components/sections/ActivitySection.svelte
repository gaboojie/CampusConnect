<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { getJson, isAbortError } from '../../lib/api'
  import { formatHours, plural } from '../../lib/analytics'
  import { formatDate } from '../../lib/format'
  import { routeHash } from '../../lib/routes'
  import type { UserAnalytics } from '../../lib/types'
  import BarList from '../analytics/BarList.svelte'
  import MonthlyChart from '../analytics/MonthlyChart.svelte'
  import OutcomeBar from '../analytics/OutcomeBar.svelte'

  let analytics: UserAnalytics | null = null
  let loading = true
  let error = ''
  let controller: AbortController | undefined

  async function load() {
    controller?.abort()
    const request = new AbortController()
    controller = request
    loading = true
    error = ''

    try {
      analytics = (await getJson<{ analytics: UserAnalytics }>('/api/analytics/me', request.signal)).analytics
    } catch (caught) {
      if (isAbortError(caught)) return
      error = caught instanceof Error ? caught.message : 'Unable to load your activity.'
    } finally {
      if (controller === request) loading = false
    }
  }

  onMount(load)
  onDestroy(() => controller?.abort())

  $: overview = analytics?.overview
  $: cancellationShare =
    overview && overview.total > 0 ? Math.round((overview.cancelled / overview.total) * 100) : 0
  $: categoryItems = (analytics?.categories ?? []).map((category) => ({
    key: category.id,
    label: category.name,
    value: category.reservations,
    detail: formatHours(category.hours),
  }))
</script>

<section class="activity-page">
  <div class="page-heading">
    <h2>My Activity</h2>
    <p class="muted">A summary of your CampusConnect reservations.</p>
  </div>

  {#if loading && !analytics}
    <div class="panel" aria-live="polite"><p class="muted">Loading your activity…</p></div>
  {:else if error}
    <div class="notice error-notice state-notice" role="alert">
      <p>{error}</p>
      <button type="button" class="secondary-button" on:click={load}>Try again</button>
    </div>
  {:else if analytics && overview && overview.total === 0}
    <div class="panel empty-state">
      <p class="muted">You haven't made any reservations yet. Your activity will appear here after your first booking.</p>
      <a class="text-link" href={routeHash('resources')}>Browse resources</a>
    </div>
  {:else if analytics && overview}
    <div class="stat-grid activity-stats">
      <div class="panel stat-card stat-card-static">
        <span class="stat-value">{overview.total}</span>
        <span class="stat-label">Total Reservations</span>
        <span class="stat-detail muted">Every status, including cancelled</span>
      </div>
      <div class="panel stat-card stat-card-static">
        <span class="stat-value">{overview.upcoming}</span>
        <span class="stat-label">Upcoming</span>
        <span class="stat-detail muted">
          {overview.byOutcome.in_progress > 0
            ? `Plus ${overview.byOutcome.in_progress} in progress now`
            : 'Confirmed and not started yet'}
        </span>
      </div>
      <div class="panel stat-card stat-card-static">
        <span class="stat-value">{overview.past}</span>
        <span class="stat-label">Past</span>
        <span class="stat-detail muted">
          {overview.byOutcome.completed} recorded completed · {overview.byOutcome.past} time ended
        </span>
      </div>
      <div class="panel stat-card stat-card-static">
        <span class="stat-value">{overview.cancelled}</span>
        <span class="stat-label">Cancelled</span>
        <span class="stat-detail muted">{cancellationShare}% of all reservations</span>
      </div>
      <div class="panel stat-card stat-card-static">
        <span class="stat-value">{formatHours(overview.pastReservedHours)}</span>
        <span class="stat-label">Past Reserved Hours</span>
        <span class="stat-detail muted">Booked time of your past reservations</span>
      </div>
    </div>

    <section class="panel activity-panel">
      <h3>Monthly reservation activity</h3>
      <p class="muted activity-panel-note">Reservations by start month over the last six months.</p>
      <MonthlyChart monthly={analytics.monthly} />
    </section>

    <div class="activity-columns">
      <section class="panel activity-panel">
        <h3>Reservations by category</h3>
        <p class="muted activity-panel-note">Reservation count and reserved hours. Cancelled reservations are not included.</p>
        {#if categoryItems.length > 0}
          <BarList items={categoryItems} label="Reservations by resource category" />
        {:else}
          <p class="muted">Nothing to show yet. Cancelled reservations and reservations with an unrecognized status are not included.</p>
        {/if}
      </section>

      <section class="panel activity-panel">
        <h3>Reservation outcomes</h3>
        <p class="muted activity-panel-note">All {plural(overview.total, 'reservation')}, by what happened to each one.</p>
        <OutcomeBar counts={overview.byOutcome} />
      </section>
    </div>

    <section class="activity-panel">
      <div class="activity-table-heading">
        <h3>Most-reserved resources</h3>
        <p class="muted activity-panel-note">Your top five resources. Cancelled reservations are not included.</p>
      </div>
      <div class="panel table-panel">
        {#if analytics.topResources.length > 0}
          <div class="table-scroll">
            <table class="data-table">
              <thead>
                <tr>
                  <th scope="col">Resource</th>
                  <th scope="col">Building</th>
                  <th scope="col">Reservations</th>
                  <th scope="col">Reserved hours</th>
                  <th scope="col">Most recent</th>
                </tr>
              </thead>
              <tbody>
                {#each analytics.topResources as resource (resource.id)}
                  <tr>
                    <td><a href={`${routeHash('resources')}/${resource.id}`}>{resource.name}</a></td>
                    <td>{resource.building.name}</td>
                    <td>{resource.reservations}</td>
                    <td>{formatHours(resource.hours)}</td>
                    <td>{formatDate(resource.lastReservedAt)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <p class="muted">Nothing to show yet. Cancelled reservations and reservations with an unrecognized status are not included.</p>
        {/if}
      </div>
    </section>

    <p class="chart-note muted">
      "Completed" and "No-show" are statuses stored with the reservation. "Past" means a confirmed reservation
      whose booked time has ended. CampusConnect does not record whether you attended it.
    </p>
  {/if}
</section>
