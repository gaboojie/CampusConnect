<script lang="ts">
  import { OUTCOMES } from '../../lib/analytics'
  import type { OutcomeCounts } from '../../lib/types'

  export let counts: OutcomeCounts
  // Show each count and share of the total next to its label.
  export let detailed = false

  $: total = Object.values(counts).reduce((sum, count) => sum + count, 0)
  $: shown = OUTCOMES.filter((outcome) => counts[outcome.id] > 0)
</script>

<ul class="chart-legend" class:chart-legend-detailed={detailed}>
  {#each shown as outcome (outcome.id)}
    <li title={outcome.description}>
      <span class="chart-swatch" style:background={outcome.color} aria-hidden="true"></span>
      <span class="chart-legend-label">{outcome.label}</span>
      {#if detailed}
        <span class="chart-legend-value">
          {counts[outcome.id]}
          <span class="muted">({Math.round((counts[outcome.id] / total) * 100)}%)</span>
        </span>
        <span class="chart-legend-description muted">{outcome.description}</span>
      {/if}
    </li>
  {/each}
</ul>
