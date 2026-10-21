<script lang="ts">
  import { onMount } from 'svelte'
  import { formatDuration } from '../../lib/format'
  import type { SlotInput } from '../../lib/types'

  export let title: string
  export let subtitle: string
  export let submitLabel: string
  export let initial: SlotInput
  export let maxMinutes: number | null = null
  // Rejects with an Error whose message is shown in the form.
  export let onSubmit: (slot: SlotInput) => Promise<void>
  export let onClose: () => void

  const today = new Date().toLocaleDateString('en-CA')

  let date = initial.date
  let start = initial.start
  let end = initial.end
  let submitting = false
  let error = ''
  let dateInput: HTMLInputElement

  $: localError = date && start && end && end <= start ? 'End time must be after the start time.' : ''

  async function submit() {
    if (submitting || localError) return
    submitting = true
    error = ''

    try {
      await onSubmit({ date, start, end })
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Unable to save the reservation.'
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

  onMount(() => dateInput?.focus())
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="modal-layer">
  <button type="button" class="modal-backdrop" aria-label="Close" on:click={close}></button>
  <dialog open class="modal" aria-labelledby="reservation-form-title">
    <div class="modal-heading">
      <div>
        <p class="eyebrow">{subtitle}</p>
        <h2 id="reservation-form-title">{title}</h2>
      </div>
      <button type="button" class="modal-close" aria-label="Close" on:click={close}>×</button>
    </div>

    <form class="reservation-form" on:submit|preventDefault={submit}>
      <label>
        Date
        <input type="date" min={today} bind:value={date} bind:this={dateInput} required />
      </label>
      <div class="time-row">
        <label>
          Start
          <input type="time" step="900" bind:value={start} required />
        </label>
        <label>
          End
          <input type="time" step="900" bind:value={end} required />
        </label>
      </div>

      <p class="muted reservation-form-hint">
        Times are campus time (Eastern).
        {#if maxMinutes}Bookings can be up to {formatDuration(maxMinutes)}.{/if}
      </p>

      {#if localError}
        <p class="field-error" role="status">{localError}</p>
      {/if}
      {#if error}
        <p class="notice error-notice reservation-form-error" role="alert">{error}</p>
      {/if}

      <div class="reservation-form-actions">
        <button type="button" class="secondary-button" on:click={close} disabled={submitting}>Back</button>
        <button type="submit" disabled={submitting || Boolean(localError)}>
          {submitting ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  </dialog>
</div>
