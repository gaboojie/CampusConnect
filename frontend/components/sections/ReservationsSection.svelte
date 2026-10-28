<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { getJson, isAbortError, sendJson } from '../../lib/api'
  import { formatClock, formatDate } from '../../lib/format'
  import type { MyReservationsResponse, Reservation, SlotInput } from '../../lib/types'
  import ReservationForm from '../reservations/ReservationForm.svelte'

  type Tab = 'upcoming' | 'past'

  let reservations: MyReservationsResponse | null = null
  let loading = true
  let error = ''
  let tab: Tab = 'upcoming'
  let controller: AbortController | undefined

  let editing: Reservation | null = null
  let cancelling: Reservation | null = null
  let cancelSubmitting = false
  let cancelError = ''
  let message = ''

  $: shown = reservations ? reservations[tab] : []

  async function load() {
    controller?.abort()
    const request = new AbortController()
    controller = request
    loading = true
    error = ''

    try {
      reservations = await getJson<MyReservationsResponse>('/api/reservations/mine', request.signal)
    } catch (caught) {
      if (isAbortError(caught)) return
      error = caught instanceof Error ? caught.message : 'Unable to load your reservations.'
    } finally {
      if (controller === request) loading = false
    }
  }

  // API timestamps look like "2026-10-20T09:00:00" (campus time).
  function slotOf(reservation: Reservation): SlotInput {
    return {
      date: reservation.startTime.slice(0, 10),
      start: reservation.startTime.slice(11, 16),
      end: reservation.endTime.slice(11, 16),
    }
  }

  function statusLabel(reservation: Reservation, inUpcoming: boolean): { text: string; tone: string } {
    switch (reservation.status) {
      case 'confirmed':
        return inUpcoming && !reservation.canModify
          ? { text: 'In progress', tone: 'active' }
          : { text: 'Confirmed', tone: 'confirmed' }
      case 'cancelled':
        return { text: 'Cancelled', tone: 'cancelled' }
      case 'completed':
        return { text: 'Completed', tone: 'completed' }
      case 'no_show':
        return { text: 'No-show', tone: 'cancelled' }
      default:
        return { text: reservation.status, tone: 'completed' }
    }
  }

  async function reschedule(slot: SlotInput) {
    if (!editing) return
    const { reservation } = await sendJson<{ reservation: Reservation }>(
      'PATCH',
      `/api/reservations/${editing.id}`,
      slot,
    )
    editing = null
    message = `${reservation.resource.name} moved to ${formatDate(reservation.startTime)}, ${formatClock(
      reservation.startTime.slice(11, 16),
    )}.`
    await load()
  }

  function openCancel(reservation: Reservation) {
    cancelling = reservation
    cancelError = ''
  }

  function closeCancel() {
    if (!cancelSubmitting) cancelling = null
  }

  async function confirmCancel() {
    if (!cancelling || cancelSubmitting) return
    cancelSubmitting = true
    cancelError = ''

    try {
      await sendJson('POST', `/api/reservations/${cancelling.id}/cancel`)
      message = `Your reservation for ${cancelling.resource.name} was cancelled.`
      cancelling = null
      await load()
    } catch (caught) {
      cancelError = caught instanceof Error ? caught.message : 'Unable to cancel the reservation.'
    } finally {
      cancelSubmitting = false
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && cancelling) closeCancel()
  }

  onMount(load)
  onDestroy(() => controller?.abort())
</script>

<svelte:window on:keydown={handleKeydown} />

<section class="reservations">
  <div class="page-heading">
    <h2>My Reservations</h2>
    <p class="muted">Change the time of or cancel a reservation any time before it starts.</p>
  </div>

  <div class="reservation-tabs" role="tablist" aria-label="Reservations">
    <button
      type="button"
      role="tab"
      class="reservation-tab"
      aria-selected={tab === 'upcoming'}
      on:click={() => (tab = 'upcoming')}
    >
      Upcoming{reservations ? ` (${reservations.upcoming.length})` : ''}
    </button>
    <button
      type="button"
      role="tab"
      class="reservation-tab"
      aria-selected={tab === 'past'}
      on:click={() => (tab = 'past')}
    >
      Past{reservations ? ` (${reservations.past.length})` : ''}
    </button>
  </div>

  {#if message}
    <p class="notice success-notice reservation-message" role="status">{message}</p>
  {/if}

  {#if loading && !reservations}
    <div class="panel" aria-live="polite"><p class="muted">Loading reservations…</p></div>
  {:else if error}
    <div class="notice error-notice state-notice" role="alert">
      <p>{error}</p>
      <button type="button" class="secondary-button" on:click={load}>Try again</button>
    </div>
  {:else if shown.length === 0}
    <div class="panel empty-state">
      <p class="muted">
        {tab === 'upcoming' ? 'You have no upcoming reservations.' : 'No past reservations yet.'}
      </p>
      {#if tab === 'upcoming'}<a class="text-link" href="#/resources">Browse resources</a>{/if}
    </div>
  {:else}
    <ul class="reservation-list" aria-label={tab === 'upcoming' ? 'Upcoming reservations' : 'Past reservations'}>
      {#each shown as reservation (reservation.id)}
        {@const status = statusLabel(reservation, tab === 'upcoming')}
        <li class="panel reservation-card">
          <div class="reservation-card-body">
            <span class={`badge status-badge status-${status.tone}`}>{status.text}</span>
            <h3><a href={`#/resources/${reservation.resource.id}`}>{reservation.resource.name}</a></h3>
            <p class="muted">{reservation.building.name}</p>
            <p class="reservation-when">
              {formatDate(reservation.startTime)} ·
              {formatClock(reservation.startTime.slice(11, 16))} – {formatClock(reservation.endTime.slice(11, 16))}
            </p>
          </div>

          {#if reservation.canModify}
            <div class="reservation-card-actions">
              <button type="button" class="secondary-button" on:click={() => { message = ''; editing = reservation }}>
                Change time
              </button>
              <button type="button" class="danger-button" on:click={() => { message = ''; openCancel(reservation) }}>
                Cancel
              </button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

{#if editing}
  <ReservationForm
    title={editing.resource.name}
    subtitle="Change time"
    submitLabel="Save new time"
    initial={slotOf(editing)}
    onSubmit={reschedule}
    onClose={() => (editing = null)}
  />
{/if}

{#if cancelling}
  <div class="modal-layer">
    <button type="button" class="modal-backdrop" aria-label="Keep reservation" on:click={closeCancel}></button>
    <dialog open class="modal" aria-labelledby="cancel-title" role="alertdialog">
      <div class="modal-heading">
        <div>
          <p class="eyebrow">Cancel reservation</p>
          <h2 id="cancel-title">Cancel this reservation?</h2>
        </div>
        <button type="button" class="modal-close" aria-label="Keep reservation" on:click={closeCancel}>×</button>
      </div>

      <p>
        <strong>{cancelling.resource.name}</strong><br />
        <span class="muted">
          {formatDate(cancelling.startTime)} ·
          {formatClock(cancelling.startTime.slice(11, 16))} – {formatClock(cancelling.endTime.slice(11, 16))}
        </span>
      </p>
      <p class="muted">The time slot will be released for other students. This can't be undone.</p>

      {#if cancelError}
        <p class="notice error-notice reservation-form-error" role="alert">{cancelError}</p>
      {/if}

      <div class="reservation-form-actions">
        <button type="button" class="secondary-button" on:click={closeCancel} disabled={cancelSubmitting}>
          Keep reservation
        </button>
        <button type="button" class="danger-button" on:click={confirmCancel} disabled={cancelSubmitting}>
          {cancelSubmitting ? 'Cancelling…' : 'Cancel reservation'}
        </button>
      </div>
    </dialog>
  </div>
{/if}
