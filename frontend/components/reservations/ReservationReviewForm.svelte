<script lang="ts">
  import type { OwnerUserReview } from '../../lib/types'

  export let reservation: OwnerUserReview
  export let onSubmit: (input: { reservationId: number; rating: number; reason: string | null; isAnonymous: boolean }) => Promise<void>
  export let onClose: () => void

  let rating = 0
  let reason = ''
  let isAnonymous = false
  let submitting = false
  let error = ''

  async function submit() {
    if (submitting || rating === 0) return
    submitting = true
    error = ''
    try {
      await onSubmit({
        reservationId: reservation.reservationId,
        rating,
        reason: reason.trim() || null,
        isAnonymous,
      })
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Unable to save this review.'
    } finally {
      submitting = false
    }
  }

  function close() {
    if (!submitting) onClose()
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') close()
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="modal-layer">
  <button type="button" class="modal-backdrop" aria-label="Close review form" on:click={close}></button>
  <dialog open class="modal reservation-review-modal" aria-labelledby="reservation-review-title">
    <div class="modal-heading">
      <div>
        <p class="eyebrow">Past reservation</p>
        <h2 id="reservation-review-title">Review {reservation.reserver.username}</h2>
        <p class="muted">{reservation.startTime.replace('T', ' ')} – {reservation.endTime.slice(11, 16)}</p>
      </div>
      <button type="button" class="modal-close" aria-label="Close review form" on:click={close}>×</button>
    </div>

    <form class="reservation-review-form" on:submit|preventDefault={submit}>
      <fieldset class="rating-fieldset">
        <legend>Rating</legend>
        <div class="star-picker" role="radiogroup" aria-label="Rating from 1 to 5 stars">
          {#each [1, 2, 3, 4, 5] as value}
            <button
              type="button"
              class="star-picker-button"
              class:selected={value <= rating}
              role="radio"
              aria-checked={value === rating}
              aria-label={`${value} star${value === 1 ? '' : 's'}`}
              on:click={() => rating = value}
              disabled={submitting}
            >★</button>
          {/each}
        </div>
        {#if rating === 0}<span class="form-help">Choose a rating from 1 to 5 stars.</span>{/if}
      </fieldset>

      <label>
        Reason <span class="optional">(optional)</span>
        <textarea bind:value={reason} maxlength="500" rows="4" disabled={submitting} placeholder="Share a short note about the reservation experience."></textarea>
        <span class="form-help">{reason.length}/500 characters</span>
      </label>

      <label class="checkbox-label">
        <input type="checkbox" bind:checked={isAnonymous} disabled={submitting} />
        Submit anonymously
      </label>

      {#if error}<p class="notice error-notice form-error" role="alert">{error}</p>{/if}

      <div class="form-actions">
        <button type="button" class="secondary-button" on:click={close} disabled={submitting}>Cancel</button>
        <button type="submit" disabled={submitting || rating === 0}>{submitting ? 'Saving…' : 'Submit review'}</button>
      </div>
    </form>
  </dialog>
</div>
