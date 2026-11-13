<script lang="ts">
  import { ApiError, sendJson } from '../lib/api'
  import type { AdminBuilding } from '../lib/types'

  export let building: AdminBuilding | null = null
  export let onSaved: (building: AdminBuilding) => void
  export let onCancel: () => void

  let name = building?.name ?? ''
  let address = building?.address ?? ''
  let latitude = building ? String(building.latitude) : ''
  let longitude = building ? String(building.longitude) : ''
  let googlePlaceId = building?.googlePlaceId ?? ''
  let saving = false
  let error = ''
  let fieldErrors: Record<string, string> = {}

  async function submit() {
    saving = true
    error = ''
    fieldErrors = {}

    const payload = {
      name,
      address,
      latitude,
      longitude,
      googlePlaceId: googlePlaceId.trim() ? googlePlaceId.trim() : null,
    }

    try {
      const response = building
        ? await sendJson<{ building: AdminBuilding }>('PATCH', `/api/admin/buildings/${building.id}`, payload)
        : await sendJson<{ building: AdminBuilding }>('POST', '/api/admin/buildings', payload)
      onSaved(response.building)
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Unable to save this building.'
      if (caught instanceof ApiError) fieldErrors = caught.fieldErrors
    } finally {
      saving = false
    }
  }
</script>

<form class="panel admin-form" on:submit|preventDefault={submit}>
  <div>
    <h3>{building ? `Edit ${building.name}` : 'Add building'}</h3>
    <p class="muted">Name, address, and coordinates are required. Leave the Google place id blank if this building does not have one.</p>
  </div>

  {#if error}
    <p class="notice error-notice" role="alert">{error}</p>
  {/if}
  {#if fieldErrors.form}
    <p class="notice error-notice" role="alert">{fieldErrors.form}</p>
  {/if}

  <div class="admin-form-grid">
    <label>
      Name
      <input bind:value={name} autocomplete="off" maxlength="120" required />
      {#if fieldErrors.name}<span class="field-error">{fieldErrors.name}</span>{/if}
    </label>
    <label>
      Address
      <input bind:value={address} autocomplete="off" maxlength="200" required />
      {#if fieldErrors.address}<span class="field-error">{fieldErrors.address}</span>{/if}
    </label>
    <label>
      Latitude
      <input bind:value={latitude} inputmode="decimal" autocomplete="off" placeholder="37.228000" required />
      {#if fieldErrors.latitude}<span class="field-error">{fieldErrors.latitude}</span>{/if}
    </label>
    <label>
      Longitude
      <input bind:value={longitude} inputmode="decimal" autocomplete="off" placeholder="-80.423000" required />
      {#if fieldErrors.longitude}<span class="field-error">{fieldErrors.longitude}</span>{/if}
    </label>
    <label>
      Google place id
      <input bind:value={googlePlaceId} autocomplete="off" maxlength="255" />
      {#if fieldErrors.googlePlaceId}<span class="field-error">{fieldErrors.googlePlaceId}</span>{/if}
    </label>
  </div>

  <div class="password-actions">
    <button type="submit" disabled={saving}>{saving ? 'Saving…' : building ? 'Save building' : 'Add building'}</button>
    <button type="button" class="secondary-button" disabled={saving} on:click={onCancel}>Cancel</button>
  </div>
</form>
