<script lang="ts">
  import { formatRating } from '../../lib/format'
  import type { ResourceSummary } from '../../lib/types'

  export let resource: ResourceSummary
  export let href: string
</script>

<a class="resource-card" {href}>
  {#if resource.thumbnailUrl}
    <img class="resource-thumb" src={resource.thumbnailUrl} alt="" loading="lazy" />
  {:else}
    <div class="resource-thumb resource-thumb-placeholder" aria-hidden="true">
      <svg class="nav-icon" viewBox="0 0 24 24">
        <path d="M4 20V8l8-4 8 4v12" />
        <path d="M9 20v-6h6v6" />
      </svg>
    </div>
  {/if}

  <div class="resource-card-body">
    <span class="badge">{resource.category.name}</span>
    <h3>{resource.name}</h3>
    <p class="resource-card-meta">{resource.building.name} · Seats {resource.capacity}</p>
    <p class="resource-card-description">{resource.shortDescription}</p>
    <p class="resource-card-rating">
      {#if resource.averageRating !== null}<span class="star" aria-hidden="true">★</span>{/if}
      {formatRating(resource.averageRating, resource.reviewCount)}
    </p>
  </div>
</a>
