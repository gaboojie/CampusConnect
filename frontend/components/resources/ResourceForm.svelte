<script lang="ts">
  import type { AvailabilityRepeat, ListingDetails, ListingFormOptions } from '../../lib/types'

  export let title = 'Create resource'
  export let submitLabel = 'Create resource'
  export let initial: ListingDetails | null = null
  export let options: ListingFormOptions
  export let onSubmit: (body: FormData, onProgress: (loaded: number, total: number) => void) => Promise<void>
  export let onClose: () => void

  let name = initial?.name ?? ''
  let description = initial?.description ?? ''
  let locationDescription = initial?.locationDescription ?? ''
  let buildingId = initial ? String(initial.building.id) : ''
  let categoryId = initial ? String(initial.category.id) : ''
  let requiredCredits = initial ? String(initial.requiredCredits) : '1'
  let capacity = initial ? String(initial.capacity) : '1'
  let hours = initial?.maxReservationMinutes === null || initial?.maxReservationMinutes === undefined
    ? ''
    : String(Math.floor(initial.maxReservationMinutes / 60))
  let minutes = initial?.maxReservationMinutes === null || initial?.maxReservationMinutes === undefined
    ? ''
    : String(initial.maxReservationMinutes % 60)
  type FormAvailabilitySlot = {
    id?: number
    startTime: string
    endTime: string
    repeat: AvailabilityRepeat
    repeatsUntil: string
  }

  const repeatOptions: Array<{ value: AvailabilityRepeat; label: string }> = [
    { value: 'none', label: 'Does not repeat' },
    { value: 'daily', label: 'Every day' },
    { value: 'every_other_day', label: 'Every other day' },
    { value: 'weekly', label: 'Every week' },
    { value: 'every_other_week', label: 'Every other week' },
  ]

  function pad(value: number): string {
    return String(value).padStart(2, '0')
  }

  function campusNow(): string {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date())
    const part = (type: string) => Number(parts.find((item) => item.type === type)?.value ?? 0)
    return `${part('year')}-${pad(part('month'))}-${pad(part('day'))}T${pad(part('hour'))}:${pad(part('minute'))}`
  }

  function shiftLocal(value: string, years = 0, hours = 0): string {
    const date = new Date(`${value}:00Z`)
    date.setUTCFullYear(date.getUTCFullYear() + years)
    date.setUTCHours(date.getUTCHours() + hours)
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
  }

  function newAvailabilitySlot(): FormAvailabilitySlot {
    const startTime = campusNow()
    return { startTime, endTime: shiftLocal(startTime, 0, 1), repeat: 'none', repeatsUntil: '' }
  }

  let availability: FormAvailabilitySlot[] = initial?.availability?.map((slot) => ({
    id: slot.id,
    startTime: slot.startTime,
    endTime: slot.endTime,
    repeat: slot.repeat,
    repeatsUntil: slot.repeatsUntil ?? '',
  })) ?? [{ ...newAvailabilitySlot(), endTime: shiftLocal(campusNow(), 1) }]
  let removeImage = false
  let submitting = false
  let error = ''
  let progress = 0
  let imageUploadSelected = false
  let formElement: HTMLFormElement

  $: durationError = (() => {
    if (!hours && !minutes) return ''
    const hourValue = Number(hours || 0)
    const minuteValue = Number(minutes || 0)
    if (!Number.isInteger(hourValue) || hourValue < 0 || !Number.isInteger(minuteValue) || minuteValue < 0 || minuteValue > 59) {
      return 'Use whole hours and 0–59 minutes.'
    }
    if (hourValue * 60 + minuteValue < 1) return 'Maximum reservation time must be at least one minute.'
    return ''
  })()

  async function submit() {
    error = ''
    if (durationError) {
      error = durationError
      return
    }

    const body = new FormData(formElement)
    body.set('availability', JSON.stringify(availability.map(({ id: _id, ...slot }) => ({
      ...slot,
      repeatsUntil: slot.repeat === 'none' ? null : slot.repeatsUntil,
    }))))
    const image = body.get('image')
    imageUploadSelected = typeof File !== 'undefined' && image instanceof File && image.size > 0
    body.set('removeImage', String(removeImage))
    submitting = true
    progress = 0
    try {
      await onSubmit(body, (loaded, total) => {
        progress = total > 0 ? Math.round((loaded / total) * 100) : 0
      })
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Unable to save this resource.'
    } finally {
      submitting = false
    }
  }

  function close() {
    if (!submitting) onClose()
  }

  function addAvailability() {
    availability = [...availability, newAvailabilitySlot()]
  }

  function removeAvailability(index: number) {
    if (availability.length <= 1) {
      error = 'Keep at least one availability slot.'
      return
    }
    availability = availability.filter((_slot, slotIndex) => slotIndex !== index)
  }
</script>

<div class="modal-layer">
  <button type="button" class="modal-backdrop" aria-label="Close" on:click={close}></button>
  <dialog open class="modal listing-form-modal" aria-labelledby="listing-form-title">
    <div class="modal-heading">
      <div>
        <p class="eyebrow">My listings</p>
        <h2 id="listing-form-title">{title}</h2>
      </div>
      <button type="button" class="modal-close" aria-label="Close" on:click={close}>×</button>
    </div>

    <form class="resource-form" bind:this={formElement} on:submit|preventDefault={submit}>
      <section class="form-section" aria-labelledby="resource-basics-title">
        <div class="form-section-heading">
          <div>
            <h3 id="resource-basics-title">Basic information</h3>
            <p class="muted">Give your resource a clear name and a short description.</p>
          </div>
          <span class="section-step">1</span>
        </div>
        <div class="form-grid two-up">
          <label class="form-field-wide">
            Name
            <input name="name" bind:value={name} minlength="3" required disabled={submitting} />
          </label>
          <label class="form-field-wide">
            Description
            <textarea name="description" bind:value={description} minlength="3" required disabled={submitting}></textarea>
          </label>
        </div>
      </section>

      <section class="form-section" aria-labelledby="resource-location-title">
        <div class="form-section-heading">
          <div>
            <h3 id="resource-location-title">Location</h3>
            <p class="muted">Tell people where to find this resource on campus.</p>
          </div>
          <span class="section-step">2</span>
        </div>
        <div class="form-grid two-up">
          <label>
            Building
            <select name="buildingId" bind:value={buildingId} required disabled={submitting}>
              <option value="" disabled>Select a building</option>
              {#each options.buildings as building (building.id)}
                <option value={String(building.id)}>{building.name}</option>
              {/each}
            </select>
          </label>
          <label>
            Category
            <select name="categoryId" bind:value={categoryId} required disabled={submitting}>
              <option value="" disabled>Select a category</option>
              {#each options.categories as category (category.id)}
                <option value={String(category.id)}>{category.name}</option>
              {/each}
            </select>
          </label>
          <label class="form-field-wide">
            Location description
            <input name="locationDescription" bind:value={locationDescription} minlength="3" required disabled={submitting} />
          </label>
        </div>
      </section>

      <section class="form-section" aria-labelledby="resource-booking-title">
        <div class="form-section-heading">
          <div>
            <h3 id="resource-booking-title">Booking details</h3>
            <p class="muted">Set how many people it accommodates and what a reservation costs.</p>
          </div>
          <span class="section-step">3</span>
        </div>
        <div class="form-grid two-up">
          <label>
            Credits per booking
            <input name="requiredCredits" type="number" min="1" max="20" step="1" bind:value={requiredCredits} required disabled={submitting} />
          </label>
          <label>
            Capacity
            <input name="capacity" type="number" min="1" max="100" step="1" bind:value={capacity} required disabled={submitting} />
          </label>
        </div>
        <fieldset class="duration-fields">
          <legend>Maximum reservation time <span class="optional">(optional)</span></legend>
          <p class="muted form-help">Leave both fields blank to allow reservations of any length.</p>
          <div class="form-grid two-up">
            <label>
              Hours
              <input name="maxReservationHours" type="number" min="0" step="1" bind:value={hours} disabled={submitting} />
            </label>
            <label>
              Minutes
              <input name="maxReservationMinutes" type="number" min="0" max="59" step="1" bind:value={minutes} disabled={submitting} />
            </label>
          </div>
          {#if durationError}<p class="field-error">{durationError}</p>{/if}
        </fieldset>
      </section>

      <fieldset class="form-section availability-fields" aria-labelledby="resource-availability-title">
        <div class="form-section-heading">
          <div>
            <h3 id="resource-availability-title">Availability</h3>
            <p class="muted">Choose when this resource can be reserved. Times use Virginia Tech campus time.</p>
          </div>
          <span class="section-step">4</span>
        </div>
        {#each availability as slot, index (slot.id ?? `new-${index}`)}
          <div class="availability-slot">
            <div class="availability-slot-heading">
              <strong>Availability {index + 1}</strong>
              <button type="button" class="secondary-button compact-button" on:click={() => removeAvailability(index)} disabled={submitting || availability.length <= 1}>Remove</button>
            </div>
            <div class="form-grid two-up">
              <label>
                Starts
                <input type="datetime-local" bind:value={slot.startTime} required disabled={submitting} />
              </label>
              <label>
                Ends
                <input type="datetime-local" min={slot.startTime} bind:value={slot.endTime} required disabled={submitting} />
              </label>
            </div>
            <div class="form-grid two-up">
              <label>
                Repeats
                <select bind:value={slot.repeat} disabled={submitting}>
                  {#each repeatOptions as option}
                    <option value={option.value}>{option.label}</option>
                  {/each}
                </select>
              </label>
              {#if slot.repeat !== 'none'}
                <label>
                  Repeats until
                  <input type="datetime-local" min={slot.endTime} bind:value={slot.repeatsUntil} required disabled={submitting} />
                </label>
              {/if}
            </div>
          </div>
        {/each}
        <button type="button" class="secondary-button add-availability-button" on:click={addAvailability} disabled={submitting}>+ Add availability slot</button>
      </fieldset>

      <section class="form-section" aria-labelledby="resource-image-title">
        <div class="form-section-heading">
          <div>
            <h3 id="resource-image-title">Resource image</h3>
            <p class="muted">Add an optional JPEG, PNG, or WebP image up to 1 MB.</p>
          </div>
          <span class="section-step">5</span>
        </div>
        <label>
          Upload image <span class="optional">(optional)</span>
          <input name="image" type="file" accept="image/jpeg,image/png,image/webp" disabled={submitting} />
        </label>
        {#if initial?.images.length}
          <label class="checkbox-label">
            <input type="checkbox" bind:checked={removeImage} disabled={submitting} />
            Remove current image
          </label>
        {/if}
      </section>

      {#if submitting && imageUploadSelected && progress > 0}
        <div class="upload-progress" aria-live="polite">
          <div class="upload-progress-bar" style={`width: ${progress}%`}></div>
          <span>Uploading image… {progress}%</span>
        </div>
      {/if}
      {#if error}<p class="notice error-notice form-error" role="alert">{error}</p>{/if}

      <div class="form-actions">
        <button type="button" class="secondary-button" on:click={close} disabled={submitting}>Cancel</button>
        <button type="submit" disabled={submitting}>{submitting ? 'Saving…' : submitLabel}</button>
      </div>
    </form>
  </dialog>
</div>
