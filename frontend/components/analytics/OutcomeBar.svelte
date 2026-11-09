<script lang="ts">
  import { OUTCOMES } from '../../lib/analytics'
  import type { OutcomeCounts } from '../../lib/types'
  import OutcomeLegend from './OutcomeLegend.svelte'

  export let counts: OutcomeCounts

  $: shown = OUTCOMES.filter((outcome) => counts[outcome.id] > 0)
  $: summary = shown.map((outcome) => `${outcome.label}: ${counts[outcome.id]}`).join(', ')
</script>

<div class="outcome-bar" role="img" aria-label={`Reservation outcomes. ${summary}.`}>
  {#each shown as outcome (outcome.id)}
    <span
      class="outcome-segment"
      style:flex-grow={counts[outcome.id]}
      style:background={outcome.color}
      title={`${outcome.label}: ${counts[outcome.id]}`}
    ></span>
  {/each}
</div>
<OutcomeLegend {counts} detailed />
