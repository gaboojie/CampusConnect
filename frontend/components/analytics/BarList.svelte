<script lang="ts">
  import type { BarItem } from '../../lib/analytics'

  export let items: BarItem[]
  export let label: string

  $: highest = Math.max(1, ...items.map((item) => item.value))
</script>

<ul class="bar-list" aria-label={label}>
  {#each items as item (item.key)}
    <li>
      <div class="bar-list-heading">
        <span class="bar-list-label">{item.label}</span>
        <span class="bar-list-value">
          {item.value}{#if item.detail}<span class="muted"> · {item.detail}</span>{/if}
        </span>
      </div>
      <div class="bar-list-track" aria-hidden="true">
        <span class="bar-list-fill" style:width={`${(item.value / highest) * 100}%`}></span>
      </div>
    </li>
  {/each}
</ul>
