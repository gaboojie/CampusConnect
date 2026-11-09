<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { getJson, isAbortError } from '../../lib/api'
  import { formatClock, formatDate, formatDateTime } from '../../lib/format'
  import type {
    CreditFilter,
    CreditSummary,
    CreditTransaction,
    CreditTransactionPage,
    PublicUser,
  } from '../../lib/types'
  import Pagination from '../Pagination.svelte'

  export let user: PublicUser
  export let onUserUpdated: (user: PublicUser) => void

  const PAGE_SIZE = 20
  const FILTERS: Array<{ value: CreditFilter; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'charges', label: 'Charges' },
    { value: 'refunds', label: 'Refunds' },
    { value: 'grants', label: 'Grants & resets' },
  ]
  const TYPE_LABELS: Record<string, string> = {
    initial_grant: 'Welcome credits',
    reservation_charge: 'Reservation charge',
    refund: 'Refund',
    monthly_reset: 'Monthly reset',
  }

  let summary: CreditSummary | null = null
  let summaryError = ''
  let history: CreditTransactionPage | null = null
  let historyError = ''
  let loadingHistory = true
  let filter: CreditFilter = 'all'
  let page = 1
  let summaryController: AbortController | undefined
  let historyController: AbortController | undefined

  async function loadSummary() {
    summaryController?.abort()
    const request = new AbortController()
    summaryController = request
    summaryError = ''

    try {
      const payload = await getJson<{ summary: CreditSummary }>('/api/credits', request.signal)
      summary = payload.summary
      // Keep the balance shown elsewhere (e.g. the profile page) current.
      if (summary.balance !== user.creditBalance) {
        onUserUpdated({ ...user, creditBalance: summary.balance })
      }
    } catch (caught) {
      if (isAbortError(caught)) return
      summaryError = caught instanceof Error ? caught.message : 'Unable to load your credits.'
    }
  }

  async function loadHistory() {
    historyController?.abort()
    const request = new AbortController()
    historyController = request
    loadingHistory = true
    historyError = ''

    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), type: filter })
    try {
      history = await getJson<CreditTransactionPage>(`/api/credits/transactions?${params}`, request.signal)
    } catch (caught) {
      if (isAbortError(caught)) return
      history = null
      historyError = caught instanceof Error ? caught.message : 'Unable to load your credit history.'
    } finally {
      if (historyController === request) loadingHistory = false
    }
  }

  function selectFilter(value: CreditFilter) {
    if (value === filter) return
    filter = value
    page = 1
    void loadHistory()
  }

  function goTo(next: number) {
    page = next
    void loadHistory()
  }

  function retry() {
    void loadSummary()
    void loadHistory()
  }

  function typeLabel(transaction: CreditTransaction): string {
    return TYPE_LABELS[transaction.type] ?? transaction.type
  }

  function detail(transaction: CreditTransaction): string {
    switch (transaction.type) {
      case 'reservation_charge':
        return transaction.reservation ? '' : 'Booking details are not available for this charge.'
      case 'refund':
        // Refunds are not linked to a reservation in the database, so they stay generic.
        return 'Credits returned for a cancelled reservation.'
      case 'initial_grant':
        return 'Added when your account was created.'
      case 'monthly_reset':
        return 'Monthly top-up to your credit allowance.'
      default:
        return ''
    }
  }

  function signed(amount: number): string {
    return amount > 0 ? `+${amount}` : `−${Math.abs(amount)}`
  }

  $: showBalance = summary?.historyMatchesBalance ?? false

  onMount(() => {
    void loadSummary()
    void loadHistory()
  })
  onDestroy(() => {
    summaryController?.abort()
    historyController?.abort()
  })
</script>

<section class="credits-page">
  <header class="page-heading">
    <p class="eyebrow">Credits</p>
    <h2>My Credits</h2>
    <p class="muted">Credits you've received, spent on reservations, and had refunded.</p>
  </header>

  {#if summaryError}
    <div class="notice error-notice state-notice" role="alert">
      <p>{summaryError}</p>
      <button type="button" class="secondary-button" on:click={retry}>Try again</button>
    </div>
  {:else}
    <div class="stat-grid credit-stats" aria-busy={!summary}>
      <div class="panel stat-card">
        <span class="stat-value">{summary ? summary.balance : '—'}</span>
        <span class="stat-label">Current balance</span>
      </div>
      <div class="panel stat-card">
        <span class="stat-value">{summary ? summary.spent : '—'}</span>
        <span class="stat-label">Spent on reservations</span>
      </div>
      <div class="panel stat-card">
        <span class="stat-value">{summary ? summary.refunded : '—'}</span>
        <span class="stat-label">Refunded</span>
      </div>
      <div class="panel stat-card">
        <span class="stat-value">{summary ? summary.received : '—'}</span>
        <span class="stat-label">Received (grants, resets, and refunds)</span>
      </div>
    </div>
  {/if}

  <div class="panel credit-rules">
    <p>
      Each booking costs the resource's listed credits. Cancel at least 24 hours before the start for a full
      refund; later cancellations and no-shows aren't refunded. If a resource's hours change and your booking is
      cancelled, the credits you paid are returned.
    </p>
    {#if summary}
      <p class="muted">Credits last reset {formatDate(summary.creditLastReset)}.</p>
    {/if}
  </div>

  <div class="segmented" role="group" aria-label="Filter credit history by type">
    {#each FILTERS as option (option.value)}
      <button
        type="button"
        class="segment"
        class:active={filter === option.value}
        aria-pressed={filter === option.value}
        on:click={() => selectFilter(option.value)}
      >
        {option.label}
      </button>
    {/each}
  </div>

  {#if historyError}
    <p class="notice error-notice" role="alert">{historyError}</p>
  {/if}

  <div class="panel table-panel" aria-busy={loadingHistory}>
    {#if loadingHistory && !history}
      <p class="muted">Loading credit history…</p>
    {:else if history && history.items.length === 0}
      <p class="muted">{filter === 'all' ? 'No credit activity yet.' : 'No transactions of this type.'}</p>
    {:else if history}
      <div class="table-scroll">
        <table class="data-table credit-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Activity</th>
              <th class="credit-number">Amount</th>
              {#if showBalance}<th class="credit-number">Balance</th>{/if}
            </tr>
          </thead>
          <tbody>
            {#each history.items as transaction (transaction.id)}
              <tr>
                <td class="credit-date">{formatDateTime(transaction.createdAt)}</td>
                <td>
                  <span class={`badge credit-type credit-type-${transaction.type}`}>{typeLabel(transaction)}</span>
                  {#if transaction.reservation}
                    <span class="credit-activity">
                      <a href={`#/resources/${transaction.reservation.resource.id}`}>{transaction.reservation.resource.name}</a>
                      <span class="muted">
                        {transaction.reservation.building.name} ·
                        {formatDate(transaction.reservation.startTime)},
                        {formatClock(transaction.reservation.startTime.slice(11, 16))} –
                        {formatClock(transaction.reservation.endTime.slice(11, 16))}
                      </span>
                    </span>
                  {:else if detail(transaction)}
                    <span class="credit-activity muted">{detail(transaction)}</span>
                  {/if}
                </td>
                <td class="credit-number">
                  <span class={transaction.amount > 0 ? 'credit-plus' : 'credit-minus'}>{signed(transaction.amount)}</span>
                </td>
                {#if showBalance}<td class="credit-number">{transaction.balanceAfter}</td>{/if}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <Pagination page={history.page} pageSize={history.pageSize} total={history.total} onChange={goTo} />
    {/if}
  </div>
</section>
