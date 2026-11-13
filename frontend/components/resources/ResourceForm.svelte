<script lang="ts">
  import { onMount } from "svelte";
  import type {
    AvailabilityRepeat,
    ListingDetails,
    ListingFormOptions,
    ResourceFeature,
    ResourceMaintenancePeriod,
  } from "../../lib/types";

  export let title = "Create resource";
  export let submitLabel = "Create resource";
  export let initial: ListingDetails | null = null;
  export let options: ListingFormOptions;
  export let onSubmit: (
    body: FormData,
    onProgress: (loaded: number, total: number) => void,
  ) => Promise<void>;
  export let onClose: () => void;

  let name = initial?.name ?? "";
  let description = initial?.description ?? "";
  let locationDescription = initial?.locationDescription ?? "";
  let buildingId = initial ? String(initial.building.id) : "";
  let categoryId = initial ? String(initial.category.id) : "";
  let requiredCredits = initial ? String(initial.requiredCredits) : "1";
  let minUserReviewScore = initial?.minUserReviewScore === null || initial?.minUserReviewScore === undefined
    ? ""
    : initial.minUserReviewScore.toFixed(2);
  let capacity = initial ? String(initial.capacity) : "1";
  let hours = initial?.maxReservationMinutes === null || initial?.maxReservationMinutes === undefined
    ? ""
    : String(Math.floor(initial.maxReservationMinutes / 60));
  let minutes = initial?.maxReservationMinutes === null || initial?.maxReservationMinutes === undefined
    ? ""
    : String(initial.maxReservationMinutes % 60);

  type FormAvailabilitySlot = {
    id?: number;
    startTime: string;
    endTime: string;
    repeat: AvailabilityRepeat;
    repeatsUntil: string;
  };

  const repeatOptions: Array<{ value: AvailabilityRepeat; label: string }> = [
    { value: "none", label: "Does not repeat" },
    { value: "daily", label: "Every day" },
    { value: "every_other_day", label: "Every other day" },
    { value: "weekly", label: "Every week" },
    { value: "every_other_week", label: "Every other week" },
  ];

  function pad(value: number): string {
    return String(value).padStart(2, "0");
  }

  function campusNow(): string {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date());
    const part = (type: string) => Number(parts.find((item) => item.type === type)?.value ?? 0);
    return `${part("year")}-${pad(part("month"))}-${pad(part("day"))}T${pad(part("hour"))}:${pad(part("minute"))}`;
  }

  function shiftLocal(value: string, years = 0, hours = 0): string {
    const date = new Date(`${value}:00Z`);
    date.setUTCFullYear(date.getUTCFullYear() + years);
    date.setUTCHours(date.getUTCHours() + hours);
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  }

  function newAvailabilitySlot(): FormAvailabilitySlot {
    const startTime = campusNow();
    return { startTime, endTime: shiftLocal(startTime, 0, 1), repeat: "none", repeatsUntil: "" };
  }

  let availability: FormAvailabilitySlot[] = initial?.availability?.map((slot) => ({
    id: slot.id,
    startTime: slot.startTime,
    endTime: slot.endTime,
    repeat: slot.repeat,
    repeatsUntil: slot.repeatsUntil ?? "",
  })) ?? [{ ...newAvailabilitySlot(), endTime: shiftLocal(campusNow(), 1) }];
  let removeImage = false;
  let maintenancePeriods: ResourceMaintenancePeriod[] = (
    initial?.maintenancePeriods ?? initial?.upcomingMaintenance ?? []
  ).map((period) => ({
    startTime: period.startTime.slice(0, 16),
    endTime: period.endTime.slice(0, 16),
    reason: period.reason,
  }));
  let features: ResourceFeature[] = (initial?.features ?? []).map((feature) => ({ ...feature }));
  let submitting = false;
  let error = "";
  let progress = 0;
  let imageUploadSelected = false;
  let formElement: HTMLFormElement;
  type FormSection = "basic" | "booking" | "availability";
  let basicOpen = true;
  let bookingOpen = false;
  let availabilityOpen = false;
  let basicError = "";
  let bookingError = "";
  let availabilityError = "";
  const errorOpenedSections = new Set<FormSection>();

  $: durationError = (() => {
    if (!hours && !minutes) return "";
    const hourValue = Number(hours || 0);
    const minuteValue = Number(minutes || 0);
    if (!Number.isInteger(hourValue) || hourValue < 0 || !Number.isInteger(minuteValue) || minuteValue < 0 || minuteValue > 59) {
      return "Use whole hours and 0–59 minutes.";
    }
    if (hourValue * 60 + minuteValue < 1) return "Maximum reservation time must be at least one minute.";
    return "";
  })();

  function clearSectionErrors() {
    basicError = "";
    bookingError = "";
    availabilityError = "";
  }

  function setSectionError(section: FormSection, message: string) {
    if (section === "basic") {
      if (!basicOpen) errorOpenedSections.add(section);
      basicOpen = true;
      basicError = message;
    } else if (section === "booking") {
      if (!bookingOpen) errorOpenedSections.add(section);
      bookingOpen = true;
      bookingError = message;
    } else {
      if (!availabilityOpen) errorOpenedSections.add(section);
      availabilityOpen = true;
      availabilityError = message;
    }
  }

  function handleSectionToggle(section: FormSection) {
    if (errorOpenedSections.delete(section)) return;

    if (section === "basic" && basicOpen) {
      bookingOpen = false;
      availabilityOpen = false;
    } else if (section === "booking" && bookingOpen) {
      basicOpen = false;
      availabilityOpen = false;
    } else if (section === "availability" && availabilityOpen) {
      basicOpen = false;
      bookingOpen = false;
    }
  }

  function clearSectionError(section: FormSection) {
    if (section === "basic") basicError = "";
    else if (section === "booking") bookingError = "";
    else availabilityError = "";
  }

  function sectionIsValid(section: FormSection): boolean {
    const sectionElement = formElement?.querySelector<HTMLElement>(`[data-form-section="${section}"]`);
    if (!sectionElement) return false;
    return Array.from(sectionElement.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea"))
      .every((control) => control.validity.valid);
  }

  function syncSectionError(section: FormSection) {
    if (!sectionIsValid(section)) {
      setSectionError(section, "Complete the highlighted fields.");
    } else {
      clearSectionError(section);
    }
  }

  function sectionForError(message: string): FormSection | null {
    const normalized = message.toLowerCase();
    if (/(availability|repeat|maintenance|overlap|downtime)/.test(normalized)) return "availability";
    if (/(credit|capacity|review score|feature|reservation time)/.test(normalized)) return "booking";
    if (/(name|description|building|category|location|image|file)/.test(normalized)) return "basic";
    return null;
  }

  function handleInvalid(event: Event) {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const section = target?.closest<HTMLElement>("[data-form-section]")?.dataset.formSection as FormSection | undefined;
    if (section) setSectionError(section, "Complete the highlighted fields.");
    error = "Please fix the highlighted fields before creating the resource.";
  }

  function handleInput(event: Event) {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const section = target?.closest<HTMLElement>("[data-form-section]")?.dataset.formSection as FormSection | undefined;
    if (!section) {
      error = "";
      return;
    }

    if (!sectionIsValid(section)) {
      setSectionError(section, "Complete the highlighted fields.");
    } else if (!(section === "booking" && durationError)) {
      clearSectionError(section);
      if (!basicError && !bookingError && !availabilityError) error = "";
    }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (submitting) return;
    error = "";
    clearSectionErrors();
    if (durationError) {
      error = durationError;
      setSectionError("booking", durationError);
      return;
    }

    const body = new FormData(formElement);
    body.set("availability", JSON.stringify(availability.map(({ id: _id, ...slot }) => ({
      ...slot,
      repeatsUntil: slot.repeat === "none" ? null : slot.repeatsUntil,
    }))));
    body.set("maintenancePeriods", JSON.stringify(maintenancePeriods));
    body.set("features", JSON.stringify(features));
    const image = body.get("image");
    imageUploadSelected = typeof File !== "undefined" && image instanceof File && image.size > 0;
    body.set("removeImage", String(removeImage));
    submitting = true;
    progress = 0;
    try {
      await onSubmit(body, (loaded, total) => {
        progress = total > 0 ? Math.round((loaded / total) * 100) : 0;
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "Unable to save this resource.";
      const section = sectionForError(error);
      if (section) setSectionError(section, error);
    } finally {
      submitting = false;
    }
  }

  function close() {
    if (!submitting) onClose();
  }

  function addAvailability() {
    availability = [...availability, newAvailabilitySlot()];
  }

  function removeAvailability(index: number) {
    if (availability.length <= 1) {
      error = "Keep at least one availability slot.";
      setSectionError("availability", error);
      return;
    }
    availability = availability.filter((_slot, slotIndex) => slotIndex !== index);
  }

  function addMaintenancePeriod() {
    maintenancePeriods = [...maintenancePeriods, { startTime: "", endTime: "", reason: "" }];
  }

  function removeMaintenancePeriod(index: number) {
    maintenancePeriods = maintenancePeriods.filter((_period, periodIndex) => periodIndex !== index);
  }

  function addFeature() {
    features = [...features, { name: "", description: "" }];
  }

  function removeFeature(index: number) {
    features = features.filter((_feature, featureIndex) => featureIndex !== index);
  }

  onMount(() => {
    syncSectionError("basic");
    syncSectionError("booking");
    syncSectionError("availability");
  });
</script>

<div class="modal-layer">
  <button type="button" class="modal-backdrop" aria-label="Close resource form" on:click={close}></button>
  <dialog open class="modal listing-form-modal" aria-labelledby="resource-form-title">
    <div class="modal-heading">
      <div>
        <p class="eyebrow">My listings</p>
        <h2 id="resource-form-title">{title}</h2>
      </div>
      <button type="button" class="modal-close" aria-label="Close resource form" on:click={close} disabled={submitting}>×</button>
    </div>

    <form
      bind:this={formElement}
      on:submit={submit}
      on:input={handleInput}
      on:change={handleInput}
      on:invalid|capture={handleInvalid}
      enctype="multipart/form-data"
      class="resource-form"
    >
      {#if error}<div class="notice error-notice" role="alert">{error}</div>{/if}

      <details class="form-section collapsible-form-section" data-form-section="basic" bind:open={basicOpen} on:toggle={() => handleSectionToggle("basic")}>
        <summary class="form-section-heading">
          <div class="section-summary-title"><span class="section-step">1</span><div><h3 id="resource-basics-title">Basic information</h3><p class="muted">Name, description, location, and resource image.</p></div></div>
          <div class="section-summary-meta">
            {#if basicError}<span class="section-step section-error-icon" role="img" aria-label="Basic information needs attention">!</span>{/if}
            <span class="section-toggle-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg></span>
          </div>
        </summary>
        <div class="form-grid two-up">
          <label class="form-field-wide"><span class="field-label">Name <span class="required-marker" aria-hidden="true">*</span></span><input name="name" bind:value={name} minlength="3" required disabled={submitting} /></label>
          <label class="form-field-wide"><span class="field-label">Description <span class="required-marker" aria-hidden="true">*</span></span><textarea name="description" bind:value={description} minlength="3" required disabled={submitting}></textarea></label>
          <label><span class="field-label">Building <span class="required-marker" aria-hidden="true">*</span></span><select name="buildingId" bind:value={buildingId} required disabled={submitting}><option value="" disabled>Select a building</option>{#each options.buildings as building (building.id)}<option value={String(building.id)}>{building.name}</option>{/each}</select></label>
          <label><span class="field-label">Category <span class="required-marker" aria-hidden="true">*</span></span><select name="categoryId" bind:value={categoryId} required disabled={submitting}><option value="" disabled>Select a category</option>{#each options.categories as category (category.id)}<option value={String(category.id)}>{category.name}</option>{/each}</select></label>
          <label class="form-field-wide"><span class="field-label">Location description <span class="required-marker" aria-hidden="true">*</span></span><input name="locationDescription" bind:value={locationDescription} minlength="3" required disabled={submitting} /></label>
          <label class="form-field-wide"><span class="field-label">Upload image <span class="optional">(Optional)</span></span><span class="form-help field-help">JPEG, PNG, or WebP files up to 1 MB.</span><input name="image" type="file" accept="image/jpeg,image/png,image/webp" disabled={submitting} /></label>
          {#if initial?.images.length}<label class="checkbox-label form-field-wide"><input type="checkbox" bind:checked={removeImage} disabled={submitting} /> <span class="field-label">Remove current image <span class="optional">(Optional)</span></span></label>{/if}
        </div>
      </details>

      <details class="form-section collapsible-form-section booking-details" data-form-section="booking" bind:open={bookingOpen} on:toggle={() => handleSectionToggle("booking")}>
        <summary class="form-section-heading">
          <div class="section-summary-title"><span class="section-step">2</span><div><h3 id="resource-booking-title">Booking details</h3><p class="muted">Credits, capacity, review requirements, features, and booking length.</p></div></div>
          <div class="section-summary-meta">
            {#if bookingError}<span class="section-step section-error-icon" role="img" aria-label="Booking details need attention">!</span>{/if}
            <span class="section-toggle-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg></span>
          </div>
        </summary>
        <div class="form-grid two-up">
          <label><span class="field-label">Credits per booking <span class="required-marker" aria-hidden="true">*</span></span><input name="requiredCredits" type="number" min="1" max="20" step="1" bind:value={requiredCredits} required disabled={submitting} /></label>
          <label><span class="field-label">Capacity <span class="required-marker" aria-hidden="true">*</span></span><input name="capacity" type="number" min="1" max="100" step="1" bind:value={capacity} required disabled={submitting} /></label>
        </div>
        <div class="booking-options-grid">
          <fieldset class="duration-fields">
            <legend>Minimum user review score <span class="optional">(Optional)</span></legend>
            <p class="muted form-help field-help">Users must have this average received rating to reserve the resource.</p>
            <label><span class="field-label">Score <span class="optional">(Optional)</span></span><input name="minUserReviewScore" type="number" min="1" max="5" step="0.01" bind:value={minUserReviewScore} disabled={submitting} /></label>
          </fieldset>
          <fieldset class="duration-fields">
            <legend>Maximum reservation time <span class="optional">(Optional)</span></legend>
            <p class="muted form-help">Leave both fields blank to allow reservations of any length.</p>
            <div class="form-grid two-up">
              <label><span class="field-label">Hours <span class="optional">(Optional)</span></span><input name="maxReservationHours" type="number" min="0" step="1" bind:value={hours} disabled={submitting} /></label>
              <label><span class="field-label">Minutes <span class="optional">(Optional)</span></span><input name="maxReservationMinutes" type="number" min="0" max="59" step="1" bind:value={minutes} disabled={submitting} /></label>
            </div>
            {#if durationError}<p class="field-error">{durationError}</p>{/if}
          </fieldset>
        </div>
        <fieldset class="nested-form-section">
          <legend>Resource features <span class="optional">(Optional)</span></legend>
          <p class="muted">List useful equipment, amenities, or other details.</p>
        {#each features as feature, index (index)}
            <div class="form-section-heading"><strong>Feature {index + 1}</strong><button type="button" class="secondary-button" on:click={() => removeFeature(index)} disabled={submitting}>Remove</button></div>
            <label><span class="field-label">Feature name <span class="required-marker" aria-hidden="true">*</span></span><input type="text" bind:value={feature.name} minlength="2" maxlength="100" required placeholder="e.g., Scoreboard access" disabled={submitting} /></label>
            <label><span class="field-label">Description <span class="required-marker" aria-hidden="true">*</span></span><textarea bind:value={feature.description} minlength="2" maxlength="500" required rows="2" placeholder="Describe this feature..." disabled={submitting}></textarea></label>
        {/each}
          <button type="button" class="secondary-button" on:click={addFeature} disabled={submitting || features.length >= 30}>+ Add feature</button>
        </fieldset>
      </details>

      <details class="form-section collapsible-form-section" data-form-section="availability" bind:open={availabilityOpen} on:toggle={() => handleSectionToggle("availability")}>
        <summary class="form-section-heading">
          <div class="section-summary-title"><span class="section-step">3</span><div><h3 id="resource-availability-title">Availability logic</h3><p class="muted">Set reservable windows and maintenance downtime.</p></div></div>
          <div class="section-summary-meta">
            {#if availabilityError}<span class="section-step section-error-icon" role="img" aria-label="Availability logic needs attention">!</span>{/if}
            <span class="section-toggle-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg></span>
          </div>
        </summary>
        <fieldset class="nested-form-section availability-fields" aria-labelledby="resource-availability-title">
          <legend>Availability schedule <span class="required-marker" aria-hidden="true">*</span></legend>
          <p class="muted">Choose when this resource can be reserved. Times use Virginia Tech campus time.</p>
          {#each availability as slot, index (slot.id ?? `new-${index}`)}
            <div class="availability-slot">
              <div class="availability-slot-heading"><strong>Availability {index + 1}</strong><button type="button" class="secondary-button compact-button" on:click={() => removeAvailability(index)} disabled={submitting || availability.length <= 1}>Remove</button></div>
              <div class="form-grid two-up">
                <label><span class="field-label">Starts <span class="required-marker" aria-hidden="true">*</span></span><input type="datetime-local" bind:value={slot.startTime} required disabled={submitting} /></label>
                <label><span class="field-label">Ends <span class="required-marker" aria-hidden="true">*</span></span><input type="datetime-local" min={slot.startTime} bind:value={slot.endTime} required disabled={submitting} /></label>
              </div>
              <div class="form-grid two-up">
                <label><span class="field-label">Repeats</span><select bind:value={slot.repeat} disabled={submitting}>{#each repeatOptions as option}<option value={option.value}>{option.label}</option>{/each}</select></label>
                {#if slot.repeat !== "none"}<label><span class="field-label">Repeats until <span class="required-marker" aria-hidden="true">*</span></span><input type="datetime-local" min={slot.endTime} bind:value={slot.repeatsUntil} required disabled={submitting} /></label>{/if}
              </div>
            </div>
          {/each}
          <button type="button" class="secondary-button add-availability-button" on:click={addAvailability} disabled={submitting}>+ Add availability slot</button>
        </fieldset>

        <fieldset class="nested-form-section">
          <legend>Maintenance periods <span class="optional">(Optional)</span></legend>
          <p class="muted">Schedule downtime windows for this resource if needed.</p>
          {#each maintenancePeriods as period, index (index)}
            <div class="form-section-heading"><strong>Maintenance window {index + 1}</strong><button type="button" class="secondary-button" on:click={() => removeMaintenancePeriod(index)} disabled={submitting}>Remove</button></div>
            <div class="form-grid two-up">
              <label><span class="field-label">Maintenance starts <span class="required-marker" aria-hidden="true">*</span></span><input type="datetime-local" bind:value={period.startTime} required disabled={submitting} /></label>
              <label><span class="field-label">Maintenance ends <span class="required-marker" aria-hidden="true">*</span></span><input type="datetime-local" bind:value={period.endTime} min={period.startTime} required disabled={submitting} /></label>
            </div>
            <label><span class="field-label">Reason <span class="required-marker" aria-hidden="true">*</span></span><input type="text" bind:value={period.reason} minlength="3" maxlength="500" required placeholder="e.g., Scheduled equipment repair" disabled={submitting} /></label>
          {/each}
          <button type="button" class="secondary-button" on:click={addMaintenancePeriod} disabled={submitting || maintenancePeriods.length >= 20}>+ Add maintenance period</button>
        </fieldset>
      </details>

      {#if submitting && imageUploadSelected && progress > 0}<div class="upload-progress" aria-live="polite"><div class="upload-progress-bar" style={`width: ${progress}%`}></div><span>Uploading image… {progress}%</span></div>{/if}
      <div class="form-actions"><button type="button" class="secondary-button" on:click={close} disabled={submitting}>Cancel</button><button type="submit" disabled={submitting}>{submitting ? "Saving…" : submitLabel}</button></div>
    </form>
  </dialog>
</div>
