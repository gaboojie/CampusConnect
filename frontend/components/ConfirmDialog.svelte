<script lang="ts">
  export let title: string
  export let eyebrow = 'Please confirm'
  export let confirmLabel: string
  export let busyLabel = 'Working…'
  export let danger = false
  export let busy = false
  export let error = ''
  export let onConfirm: () => void
  export let onCancel: () => void

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && !busy) onCancel()
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="modal-layer">
  <button type="button" class="modal-backdrop" aria-label="Close dialog" disabled={busy} on:click={onCancel}></button>
  <dialog open class="modal" aria-labelledby="confirm-dialog-title">
    <div class="modal-heading">
      <div>
        <p class="eyebrow">{eyebrow}</p>
        <h2 id="confirm-dialog-title">{title}</h2>
      </div>
      <button type="button" class="modal-close" aria-label="Close dialog" disabled={busy} on:click={onCancel}>×</button>
    </div>

    <slot />

    {#if error}
      <p class="notice error-notice" role="alert">{error}</p>
    {/if}

    <div class="password-actions">
      <button type="button" class={danger ? 'danger-button' : ''} disabled={busy} on:click={onConfirm}>
        {busy ? busyLabel : confirmLabel}
      </button>
      <button type="button" class="secondary-button" disabled={busy} on:click={onCancel}>Cancel</button>
    </div>
  </dialog>
</div>
