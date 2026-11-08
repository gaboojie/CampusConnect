<script lang="ts">
  export let items: Array<{ label: string; value: number; color: string }>
  export let label = 'Pie chart'

  const SIZE = 200
  const CENTER = SIZE / 2
  const RADIUS = 92

  type Slice = { label: string; value: number; color: string; percent: number; path: string }

  $: total = items.reduce((sum, item) => sum + item.value, 0)
  $: slices = buildSlices(items, total)
  $: onlyOne = slices.length === 1 ? slices[0] : null

  function point(angle: number): string {
    return `${(CENTER + RADIUS * Math.cos(angle)).toFixed(2)} ${(CENTER + RADIUS * Math.sin(angle)).toFixed(2)}`
  }

  function buildSlices(rows: typeof items, sum: number): Slice[] {
    let start = -Math.PI / 2
    return rows
      .filter((row) => row.value > 0)
      .map((row) => {
        const sweep = (row.value / sum) * Math.PI * 2
        const end = start + sweep
        const path = `M ${CENTER} ${CENTER} L ${point(start)} A ${RADIUS} ${RADIUS} 0 ${sweep > Math.PI ? 1 : 0} 1 ${point(end)} Z`
        start = end
        return { ...row, percent: Math.round((row.value / sum) * 100), path }
      })
  }
</script>

{#if total === 0}
  <p class="muted">No data yet.</p>
{:else}
  <div class="pie">
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={label}>
      {#if onlyOne}
        <circle cx={CENTER} cy={CENTER} r={RADIUS} fill={onlyOne.color}>
          <title>{onlyOne.label}: {onlyOne.value} (100%)</title>
        </circle>
      {:else}
        {#each slices as slice}
          <path d={slice.path} fill={slice.color} stroke="#fff" stroke-width="2" stroke-linejoin="round">
            <title>{slice.label}: {slice.value} ({slice.percent}%)</title>
          </path>
        {/each}
      {/if}
    </svg>

    <ul class="pie-legend">
      {#each items as item}
        <li>
          <i style={`background:${item.color}`}></i>
          <span>{item.label}</span>
          <strong>{item.value}{#if item.value > 0}<small> · {Math.round((item.value / total) * 100)}%</small>{/if}</strong>
        </li>
      {/each}
    </ul>
  </div>
{/if}
