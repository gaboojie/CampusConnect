<script lang="ts">
  import { OUTCOMES, formatMonth, plural } from '../../lib/analytics'
  import type { OutcomeCounts, UserAnalytics } from '../../lib/types'
  import OutcomeLegend from './OutcomeLegend.svelte'

  export let monthly: UserAnalytics['monthly']

  $: highest = Math.max(1, ...monthly.months.map((month) => month.total))
  $: windowCounts = monthly.months.reduce((sum, month) => {
    for (const outcome of OUTCOMES) sum[outcome.id] += month.byOutcome[outcome.id]
    return sum
  }, Object.fromEntries(OUTCOMES.map((outcome) => [outcome.id, 0])) as OutcomeCounts)
  $: charted = monthly.months.reduce((sum, month) => sum + month.total, 0)

  function monthName(month: string): string {
    const [year, index] = month.split('-').map(Number)
    return new Date(year, index - 1, 1).toLocaleDateString(undefined, { month: 'short' })
  }

  function breakdown(counts: OutcomeCounts): string {
    return OUTCOMES.filter((outcome) => counts[outcome.id] > 0)
      .map((outcome) => `${outcome.label} ${counts[outcome.id]}`)
      .join(', ')
  }
</script>

<div
  class="month-chart"
  role="img"
  aria-label={monthly.months.map((month) => `${formatMonth(month.month, 'long')}: ${plural(month.total, 'reservation')}`).join('; ')}
>
  {#each monthly.months as month, index (month.month)}
    <div class="month-column">
      <span class="month-total">{month.total}</span>
      <div class="month-track">
        <div
          class="month-bar"
          style:height={`${(month.total / highest) * 100}%`}
          title={month.total ? `${formatMonth(month.month, 'long')}: ${breakdown(month.byOutcome)}` : undefined}
        >
          {#each OUTCOMES as outcome (outcome.id)}
            {#if month.byOutcome[outcome.id] > 0}
              <span class="month-segment" style:flex-grow={month.byOutcome[outcome.id]} style:background={outcome.color}></span>
            {/if}
          {/each}
        </div>
      </div>
      <span class="month-label">
        {monthName(month.month)}
        {#if index === 0 || month.month.endsWith('-01')}<span class="muted">{month.month.slice(0, 4)}</span>{/if}
      </span>
    </div>
  {/each}
</div>

{#if charted > 0}
  <OutcomeLegend counts={windowCounts} />
{/if}

{#if monthly.beforeWindow > 0 || monthly.afterWindow > 0}
  <p class="chart-note muted">
    Not shown:
    {[
      monthly.beforeWindow > 0 ? `${plural(monthly.beforeWindow, 'reservation')} before ${formatMonth(monthly.months[0].month, 'long')}` : '',
      monthly.afterWindow > 0 ? `${plural(monthly.afterWindow, 'reservation')} after ${formatMonth(monthly.months[monthly.months.length - 1].month, 'long')}` : '',
    ].filter(Boolean).join(' and ')}.
  </p>
{/if}
