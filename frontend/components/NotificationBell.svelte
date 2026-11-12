<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { isAdminPath } from '../lib/adminRoutes'
  import { getJson, isAbortError, sendJson } from '../lib/api'
  import { formatDateTime } from '../lib/format'
  import type { AppNotification, Inbox } from '../lib/types'

  type Filter = 'all' | 'unread'

  const REFRESH_MS = 60_000
  const PAGE_STEP = 10
  const MAX_ITEMS = 50
  const TYPE_LABELS: Record<string, string> = {
    reservation_reminder: 'Reminder',
    reservation_cancelled: 'Cancelled',
    resource_review_due: 'Resource review',
    user_review_due: 'Reservation review',
  }

  let root: HTMLDivElement
  let open = false
  let filter: Filter = 'all'
  let limit = PAGE_STEP
  let inbox: Inbox | null = null
  let unread = 0
  let loading = false
  let error = ''
  let markingAll = false
  let timer: ReturnType<typeof setInterval> | undefined
  let controller: AbortController | undefined

  // The admin panel lives on its own path, so links back into the app must leave it.
  const appPrefix = isAdminPath(window.location.pathname) ? '/' : ''

  $: label = unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'
  $: badge = unread > 99 ? '99+' : String(unread)

  async function load() {
    controller?.abort()
    const request = new AbortController()
    controller = request
    loading = true

    try {
      const next = await getJson<Inbox>(`/api/notifications?filter=${filter}&pageSize=${limit}`, request.signal)
      inbox = next
      unread = next.unreadCount
      error = ''
    } catch (caught) {
      if (isAbortError(caught)) return
      error = caught instanceof Error ? caught.message : 'Unable to load your notifications.'
    } finally {
      if (controller === request) loading = false
    }
  }

  // When the dropdown is closed only the badge count is needed.
  async function loadCount() {
    controller?.abort()
    const request = new AbortController()
    controller = request

    try {
      const next = await getJson<Inbox>('/api/notifications?filter=unread&pageSize=1', request.signal)
      unread = next.unreadCount
    } catch {
      // Keep the last known count if the request fails.
    }
  }

  function refresh() {
    return open ? load() : loadCount()
  }

  function toggle() {
    open = !open
    if (open) {
      limit = PAGE_STEP
      void load()
    }
  }

  function close() {
    open = false
  }

  function selectFilter(value: Filter) {
    if (value === filter) return
    filter = value
    limit = PAGE_STEP
    void load()
  }

  function showMore() {
    limit = Math.min(limit + PAGE_STEP, MAX_ITEMS)
    void load()
  }

  async function markRead(notification: AppNotification) {
    if (notification.isRead) return
    error = ''

    try {
      await sendJson('POST', `/api/notifications/${notification.id}/read`)
      await load()
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Unable to update this notification.'
    }
  }

  async function markAllRead() {
    markingAll = true
    error = ''

    try {
      await sendJson('POST', '/api/notifications/read-all')
      await load()
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Unable to update your notifications.'
    } finally {
      markingAll = false
    }
  }

  function handleWindowClick(event: MouseEvent) {
    if (open && root && !root.contains(event.target as Node)) close()
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && open) close()
  }

  onMount(() => {
    void loadCount()
    timer = setInterval(refresh, REFRESH_MS)
  })
  onDestroy(() => {
    clearInterval(timer)
    controller?.abort()
  })
</script>

<svelte:window on:click={handleWindowClick} on:keydown={handleKeydown} on:focus={refresh} />

<div class="notification-menu" bind:this={root}>
  <button
    type="button"
    class="notification-bell"
    aria-haspopup="true"
    aria-expanded={open}
    aria-controls="notification-panel"
    aria-label={label}
    title="Notifications"
    on:click={toggle}
  >
    <svg class="bell-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15Z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </svg>
    {#if unread > 0}
      <span class="bell-badge" aria-hidden="true">{badge}</span>
    {/if}
  </button>

  {#if open}
    <div id="notification-panel" class="notification-panel" role="region" aria-label="Notifications">
      <div class="notification-panel-header">
        <h2>Notifications</h2>
        <button type="button" class="text-button" disabled={markingAll || unread === 0} on:click={markAllRead}>
          {markingAll ? 'Marking…' : 'Mark all as read'}
        </button>
      </div>

      <div class="notification-tabs" role="group" aria-label="Filter notifications">
        <button type="button" class:active={filter === 'all'} aria-pressed={filter === 'all'} on:click={() => selectFilter('all')}>
          All
        </button>
        <button type="button" class:active={filter === 'unread'} aria-pressed={filter === 'unread'} on:click={() => selectFilter('unread')}>
          Unread{#if unread > 0} ({unread}){/if}
        </button>
      </div>

      <div class="notification-panel-body" aria-busy={loading}>
        {#if error}
          <p class="notification-empty error-text" role="alert">{error}</p>
        {:else if !inbox}
          <p class="notification-empty muted">Loading notifications…</p>
        {:else if inbox.items.length === 0}
          <p class="notification-empty muted">
            {filter === 'unread' ? 'You are all caught up.' : 'No notifications yet. Reservation reminders and cancellations will appear here.'}
          </p>
        {:else}
          <ul class="notification-items" class:stale={loading}>
            {#each inbox.items as notification (notification.id)}
              <li class="notification-item" class:unread={!notification.isRead}>
                <div class="notification-item-heading">
                  <span class="badge" class:badge-new={notification.type === 'reservation_reminder'}>
                    {TYPE_LABELS[notification.type] ?? 'Update'}
                  </span>
                  <time class="muted" datetime={notification.deliveredAt}>{formatDateTime(notification.deliveredAt)}</time>
                  {#if !notification.isRead}<span class="unread-dot" aria-label="Unread"></span>{/if}
                </div>
                <p>{notification.message}</p>
                <div class="notification-item-actions">
                  {#if notification.type === 'resource_review_due' || notification.type === 'user_review_due'}
                    <a class="text-link" href={`${appPrefix}#/announcements?tab=reviews`} on:click={close}>Open reviews</a>
                  {:else if notification.reservationId !== null}
                    <a class="text-link" href={`${appPrefix}#/reservations`} on:click={close}>View my reservations</a>
                  {/if}
                  {#if !notification.isRead}
                    <button type="button" class="text-button" on:click={() => markRead(notification)}>Mark as read</button>
                  {/if}
                </div>
              </li>
            {/each}
          </ul>

          {#if inbox.total > inbox.items.length && limit < MAX_ITEMS}
            <button type="button" class="text-button notification-more" disabled={loading} on:click={showMore}>
              Show more
            </button>
          {:else if inbox.total > inbox.items.length}
            <p class="notification-empty muted">Showing the latest {inbox.items.length} of {inbox.total}.</p>
          {/if}
        {/if}
      </div>
    </div>
  {/if}
</div>
