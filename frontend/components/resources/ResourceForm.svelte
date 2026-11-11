<script lang="ts">
  import type {
    ListingDetails,
    ListingFormOptions,
    ResourceMaintenancePeriod,
    ResourceFeature,
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
  let buildingId = initial?.building.id ? String(initial.building.id) : "";
  let categoryId = initial?.category.id ? String(initial.category.id) : "";
  let requiredCredits = initial?.requiredCredits ? String(initial.requiredCredits) : "1";
  let capacity = initial?.capacity ? String(initial.capacity) : "1";

  const maxMinutes = initial?.maxReservationMinutes ?? null;
  let maxHours = maxMinutes !== null ? String(Math.floor(maxMinutes / 60)) : "";
  let maxMinutesPart = maxMinutes !== null ? String(maxMinutes % 60) : "";

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
  let formElement: HTMLFormElement;

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (submitting) return;

    submitting = true;
    error = "";
    try {
      const body = new FormData(formElement);
      body.set("maintenancePeriods", JSON.stringify(maintenancePeriods));
      body.set("features", JSON.stringify(features));
      await onSubmit(body, () => {});
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "Unable to save this resource.";
    } finally {
      submitting = false;
    }
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
</script>

<div class="modal-layer">
  <button
    type="button"
    class="modal-backdrop"
    aria-label="Close resource form"
    on:click={() => !submitting && onClose()}
  ></button>
  <dialog open class="modal listing-form-modal" aria-labelledby="resource-form-title">
    <div class="modal-heading">
      <h2 id="resource-form-title">{title}</h2>
      <button type="button" class="modal-close" aria-label="Close resource form" on:click={onClose} disabled={submitting}>×</button>
    </div>
<form bind:this={formElement} on:submit={submit} enctype="multipart/form-data" class="resource-form">
  {#if error}
    <div class="notice error-notice" role="alert">{error}</div>
  {/if}

  <fieldset class="form-section">
    <div class="form-section-heading">
      <div>
        <h3>Basic Information</h3>
        <p class="muted">Provide the name and details of the resource.</p>
      </div>
      <span class="section-step">1</span>
    </div>

    <label>
      Resource Name
      <input type="text" name="name" bind:value={name} required minlength="3" placeholder="e.g., 3D Printer" disabled={submitting} />
    </label>

    <label>
      Description
      <textarea name="description" bind:value={description} required minlength="3" rows="3" placeholder="Describe the resource..." disabled={submitting}></textarea>
    </label>
  </fieldset>

  <fieldset class="form-section">
    <div class="form-section-heading">
      <div>
        <h3>Location & Category</h3>
        <p class="muted">Where is this resource located?</p>
      </div>
      <span class="section-step">2</span>
    </div>

    <div class="form-grid two-up">
      <label>
        Building
        <select name="buildingId" bind:value={buildingId} required disabled={submitting}>
          <option value="">Select building...</option>
          {#each options.buildings as building}
            <option value={String(building.id)}>{building.name}</option>
          {/each}
        </select>
      </label>

      <label>
        Category
        <select name="categoryId" bind:value={categoryId} required disabled={submitting}>
          <option value="">Select category...</option>
          {#each options.categories as category}
            <option value={String(category.id)}>{category.name}</option>
          {/each}
        </select>
      </label>
    </div>

    <label>
      Location Details
      <input type="text" name="locationDescription" bind:value={locationDescription} required minlength="3" placeholder="e.g., Room 102, Near entrance" disabled={submitting} />
    </label>
  </fieldset>

  <fieldset class="form-section">
    <div class="form-section-heading">
      <div>
        <h3>Rules & Capacity</h3>
        <p class="muted">Set limits for reservations and credits.</p>
      </div>
      <span class="section-step">3</span>
    </div>

    <div class="form-grid two-up">
      <label>
        Required Credits (1–20)
        <input type="number" name="requiredCredits" bind:value={requiredCredits} min="1" max="20" required disabled={submitting} />
      </label>

      <label>
        Capacity (1–100)
        <input type="number" name="capacity" bind:value={capacity} min="1" max="100" required disabled={submitting} />
      </label>
    </div>

    <div class="form-grid two-up">
      <label>
        Max Reservation Hours
        <input type="number" name="maxReservationHours" bind:value={maxHours} min="0" placeholder="Hours" disabled={submitting} />
      </label>

      <label>
        Max Reservation Minutes
        <input type="number" name="maxReservationMinutes" bind:value={maxMinutesPart} min="0" max="59" placeholder="Minutes" disabled={submitting} />
      </label>
    </div>
  </fieldset>

  <fieldset class="form-section">
    <div class="form-section-heading">
      <div>
        <h3>Resource Features</h3>
        <p class="muted">List useful equipment, amenities, or other details about this resource.</p>
      </div>
      <span class="section-step">4</span>
    </div>

    {#each features as feature, index (index)}
      <div class="form-section-heading">
        <strong>Feature {index + 1}</strong>
        <button type="button" class="secondary-button" on:click={() => removeFeature(index)} disabled={submitting}>Remove</button>
      </div>
      <label>
        Feature name
        <input type="text" bind:value={feature.name} minlength="2" maxlength="100" required placeholder="e.g., Scoreboard access" disabled={submitting} />
      </label>
      <label>
        Description
        <textarea bind:value={feature.description} minlength="2" maxlength="500" required rows="2" placeholder="Describe this feature..." disabled={submitting}></textarea>
      </label>
    {/each}
    <button type="button" class="secondary-button" on:click={addFeature} disabled={submitting || features.length >= 30}>
      + Add feature
    </button>
  </fieldset>

  <fieldset class="form-section availability-fields">
    <div class="form-section-heading">
      <div>
        <h3>Maintenance Period</h3>
        <p class="muted">Schedule a downtime window for this resource if needed (optional).</p>
      </div>
      <span class="section-step">5</span>
    </div>

    {#each maintenancePeriods as period, index (index)}
      <div class="form-section-heading">
        <strong>Maintenance window {index + 1}</strong>
        <button type="button" class="secondary-button" on:click={() => removeMaintenancePeriod(index)} disabled={submitting}>Remove</button>
      </div>
      <div class="form-grid two-up">
        <label>
          Maintenance Starts
          <input type="datetime-local" bind:value={period.startTime} required disabled={submitting} />
        </label>
        <label>
          Maintenance Ends
          <input type="datetime-local" bind:value={period.endTime} min={period.startTime} required disabled={submitting} />
        </label>
      </div>
      <label>
        Reason
        <input type="text" bind:value={period.reason} minlength="3" maxlength="500" required placeholder="e.g., Scheduled equipment repair" disabled={submitting} />
      </label>
    {/each}
    <button type="button" class="secondary-button" on:click={addMaintenancePeriod} disabled={submitting || maintenancePeriods.length >= 20}>
      + Add maintenance period
    </button>
  </fieldset>

  <fieldset class="form-section">
    <div class="form-section-heading">
      <div>
        <h3>Resource Image</h3>
        <p class="muted">Upload an optional image (JPEG, PNG, WebP up to 1 MB).</p>
      </div>
      <span class="section-step">6</span>
    </div>

    <label>
      Upload image
      <input type="file" name="image" accept="image/jpeg,image/png,image/webp" disabled={submitting} />
    </label>
  </fieldset>

  <div class="form-actions">
    <button type="button" class="secondary-button" on:click={onClose} disabled={submitting}>Cancel</button>
    <button type="submit" class="button primary" disabled={submitting}>
      {submitting ? "Saving..." : submitLabel}
    </button>
  </div>
</form>
  </dialog>
</div>