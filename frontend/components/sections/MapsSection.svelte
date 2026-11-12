<script lang="ts">
  /// <reference types="google.maps" />
  import { onMount, tick } from 'svelte'
  import { importLibrary, setOptions } from '@googlemaps/js-api-loader'
  import { getJson, isAbortError } from '../../lib/api'
  import type { MapBuilding, MapBuildingDetails, ResourceSearchResponse } from '../../lib/types'

  const DRILLFIELD_CENTER = { lat: 37.22751, lng: -80.42189 }
  const INITIAL_ZOOM = 16

  // Google Maps viewport restrictions are rectangular. This buffered rectangle
  // approximates Virginia Tech's central Blacksburg campus: Prices Fork Road
  // and Plantation Road to the north/west, Main Street to the east, and the
  // U.S. 460 bypass to the south. It includes the academic, residential,
  // athletic, and research areas represented by CampusConnect buildings.
  const MAIN_CAMPUS_BOUNDS = {
    north: 37.2415,
    south: 37.211,
    west: -80.444,
    east: -80.405,
  }

  type MapsConfig = {
    googleMapsJavaScriptApiKey: string | null
    mapId: string | null
  }

  let mapElement: HTMLDivElement
  let panelElement: HTMLElement
  let campusMap: google.maps.Map | null = null
  let markers: google.maps.marker.AdvancedMarkerElement[] = []
  let selectedMarker: google.maps.marker.AdvancedMarkerElement | null = null
  let selectionController: AbortController | undefined
  let loading = true
  let apiKey: string | null = null
  let mapId: string | null = null
  let error = ''
  let buildingsError = ''
  let selectedBuilding: MapBuilding | null = null
  let selectedDetails: MapBuildingDetails | null = null
  let detailsError = ''
  let failedPhotoUrls = new Set<string>()
  let resources: ResourceSearchResponse | null = null
  let resourcesLoading = false
  let resourcesError = ''
  let selectedLoading = false
  let disposed = false

  $: availablePhotos = selectedDetails?.photos.filter((photo) => !failedPhotoUrls.has(photo.url)) ?? []

  function clearMarkers() {
    for (const marker of markers) marker.map = null
    markers = []
    selectedMarker = null
  }

  function closeBuildingPanel() {
    selectionController?.abort()
    selectionController = undefined
    selectedMarker?.element.classList.remove('maps-marker-selected')
    selectedMarker = null
    selectedBuilding = null
    selectedDetails = null
    detailsError = ''
    failedPhotoUrls = new Set()
    resources = null
    resourcesError = ''
    resourcesLoading = false
    selectedLoading = false
  }

  function selectBuilding(
    building: MapBuilding,
    marker: google.maps.marker.AdvancedMarkerElement,
  ) {
    selectionController?.abort()
    selectionController = new AbortController()
    selectedBuilding = building
    selectedDetails = null
    detailsError = ''
    failedPhotoUrls = new Set()
    resources = null
    resourcesError = ''
    resourcesLoading = true
    selectedLoading = true
    selectedMarker?.element.classList.remove('maps-marker-selected')
    selectedMarker = marker
    selectedMarker.element.classList.add('maps-marker-selected')
    void loadBuildingDetails(building, selectionController)
  }

  async function loadBuildingDetails(building: MapBuilding, controller: AbortController) {
    const detailsRequest = getJson<MapBuildingDetails>(
      `/api/maps/buildings/${encodeURIComponent(building.id)}/details`,
      controller.signal,
    )
    const resourcesRequest = getJson<ResourceSearchResponse>(
      `/api/resources?building=${encodeURIComponent(building.id)}&limit=50`,
      controller.signal,
    )

    const [detailsResult, resourcesResult] = await Promise.allSettled([detailsRequest, resourcesRequest])
    if (disposed || controller.signal.aborted || selectedBuilding?.id !== building.id) return

    if (detailsResult.status === 'fulfilled') {
      selectedDetails = detailsResult.value
    } else if (!isAbortError(detailsResult.reason)) {
      detailsError = detailsResult.reason instanceof Error
        ? detailsResult.reason.message
        : 'Unable to load building photos right now.'
    }

    if (resourcesResult.status === 'fulfilled') {
      resources = resourcesResult.value
    } else if (!isAbortError(resourcesResult.reason)) {
      resourcesError = resourcesResult.reason instanceof Error
        ? resourcesResult.reason.message
        : 'Unable to load this building’s resources.'
    }

    selectedLoading = false
    resourcesLoading = false
    await tick()
    panelElement?.focus()
  }

  function handlePhotoError(url: string) {
    failedPhotoUrls = new Set([...failedPhotoUrls, url])
  }

  async function addBuildingMarkers(buildings: MapBuilding[]) {
    if (!campusMap) return

    clearMarkers()
    const { AdvancedMarkerElement, PinElement } = await importLibrary('marker')
    if (disposed || !campusMap) return

    markers = buildings.map((building) => {
      const pin = new PinElement({
        background: '#630031',
        borderColor: '#4b0025',
        glyphColor: '#fff',
        glyphText: 'B',
        scale: 1.1,
      })
      const marker = new AdvancedMarkerElement({
        map: campusMap,
        position: { lat: building.latitude, lng: building.longitude },
        title: building.name,
        content: pin,
        gmpClickable: true,
      })
      marker.addEventListener('gmp-click', () => selectBuilding(building, marker))
      return marker
    })
  }

  async function initializeMap() {
    try {
      const config = await getJson<MapsConfig>('/api/maps/config')
      if (disposed) return

      apiKey = config.googleMapsJavaScriptApiKey
      mapId = config.mapId

      if (!apiKey) {
        loading = false
        return
      }

      loading = false
      await tick()
      if (disposed) return

      setOptions({
        key: apiKey,
        v: 'weekly',
        authReferrerPolicy: 'origin',
      })

      const { Map } = await importLibrary('maps')
      if (disposed) return

      campusMap = new Map(mapElement, {
        center: DRILLFIELD_CENTER,
        zoom: INITIAL_ZOOM,
        mapTypeId: 'roadmap',
        mapId: mapId ?? 'DEMO_MAP_ID',
        clickableIcons: false,
        restriction: {
          latLngBounds: MAIN_CAMPUS_BOUNDS,
          strictBounds: true,
        },
      })

      try {
        const { buildings } = await getJson<{ buildings: MapBuilding[] }>('/api/maps/buildings')
        await addBuildingMarkers(buildings)
      } catch (reason: unknown) {
        if (!disposed) {
          buildingsError = reason instanceof Error ? reason.message : 'Unable to load campus buildings.'
        }
      }
    } catch (reason: unknown) {
      if (!disposed) {
        error = reason instanceof Error ? reason.message : 'Unable to load the Google Maps JavaScript API.'
      }
    } finally {
      if (!disposed) loading = false
    }
  }

  function handlePanelKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') closeBuildingPanel()
  }

  onMount(() => {
    void initializeMap()
    return () => {
      disposed = true
      selectionController?.abort()
      clearMarkers()
    }
  })
</script>

<svelte:window on:keydown={handlePanelKeydown} />

<section class="maps-page" aria-labelledby="maps-title">
  {#if loading}
    <div class="maps-state panel" aria-live="polite">
      <p class="eyebrow">Virginia Tech campus</p>
      <h1 id="maps-title">Maps</h1>
      <p class="muted">Loading the campus map…</p>
    </div>
  {:else if error}
    <div class="maps-state panel">
      <p class="eyebrow">Virginia Tech campus</p>
      <h1 id="maps-title">Maps</h1>
      <p class="muted">{error}</p>
      <p class="muted">Try again after the Maps integration has been configured.</p>
    </div>
  {:else if !apiKey}
    <div class="maps-state panel">
      <p class="eyebrow">Virginia Tech campus</p>
      <h1 id="maps-title">Maps</h1>
      <p class="muted">
        Google Maps is not configured for this environment yet. An administrator must add the
        <code>GOOGLE_MAPS_JAVASCRIPT_API_KEY</code> Worker secret before the interactive map can load.
      </p>
      <a
        class="button-link"
        href="https://developers.google.com/maps/documentation/javascript/get-api-key"
        target="_blank"
        rel="noreferrer"
      >
        View Google Maps setup guidance
      </a>
    </div>
  {:else}
    <div
      bind:this={mapElement}
      class="maps-canvas"
      role="application"
      aria-label="Interactive map of Virginia Tech’s Blacksburg campus"
    ></div>

    {#if buildingsError}
      <p class="maps-overlay-notice" role="alert">{buildingsError}</p>
    {/if}

    {#if selectedBuilding}
      <aside
        bind:this={panelElement}
        class="maps-building-panel"
        tabindex="-1"
        aria-labelledby="building-panel-title"
      >
        <header class="maps-building-panel-header">
          <div>
            <p class="eyebrow">Campus building</p>
            <h2 id="building-panel-title">{selectedBuilding.name}</h2>
          </div>
          <button type="button" class="maps-panel-close" aria-label="Close building details" on:click={closeBuildingPanel}>
            <span aria-hidden="true">×</span>
          </button>
        </header>

        {#if availablePhotos.length}
          <div class="maps-building-photos" aria-label="Building photos">
            {#each availablePhotos as photo, index (photo.url)}
              <figure>
                <img
                  src={photo.url}
                  alt={`${selectedBuilding.name} photo ${index + 1}`}
                  loading="lazy"
                  on:error={() => handlePhotoError(photo.url)}
                />
                {#if photo.authorAttributions.length}
                  <figcaption>
                    Photo by
                    {#each photo.authorAttributions as attribution, attributionIndex (attribution.uri)}
                      {#if attributionIndex > 0}, {/if}
                      <a href={attribution.uri} target="_blank" rel="noreferrer">{attribution.displayName}</a>
                    {/each}
                  </figcaption>
                {/if}
              </figure>
            {/each}
          </div>
        {:else}
          <img
            class="maps-building-placeholder"
            src="/building-placeholder.svg"
            alt="Virginia Tech building placeholder"
          />
        {/if}

        {#if detailsError}
          <p class="maps-panel-note" role="status">{detailsError}</p>
        {:else if selectedDetails?.photoError}
          <p class="maps-panel-note" role="status">{selectedDetails.photoError}</p>
        {:else if failedPhotoUrls.size > 0}
          <p class="maps-panel-note" role="status">Building photos are unavailable right now.</p>
        {/if}

        <section class="maps-building-location" aria-labelledby="building-location-title">
          <h3 id="building-location-title">Location</h3>
          <p>{selectedBuilding.address}</p>
          <p class="muted">{selectedBuilding.latitude}, {selectedBuilding.longitude}</p>
        </section>

        <section class="maps-building-resources" aria-labelledby="building-resources-title">
          <div class="maps-panel-section-heading">
            <h3 id="building-resources-title">Resources</h3>
            {#if resources && resources.total > resources.limit}
              <a class="text-link" href={`#/resources?building=${selectedBuilding.id}`}>View all</a>
            {/if}
          </div>

          {#if selectedLoading || resourcesLoading}
            <p class="muted" aria-live="polite">Loading building details…</p>
          {:else if resourcesError}
            <p class="maps-panel-error" role="alert">{resourcesError}</p>
          {:else if resources && resources.resources.length === 0}
            <p class="muted">No resources are listed for this building yet.</p>
          {:else if resources}
            <div class="maps-resource-list">
              {#each resources.resources as resource (resource.id)}
                <a class="maps-resource-item" href={`#/resources/${resource.id}`}>
                  <strong>{resource.name}</strong>
                  <span>{resource.category.name} · Seats {resource.capacity}</span>
                </a>
              {/each}
            </div>
          {/if}
        </section>
      </aside>
    {/if}
  {/if}
</section>
