<script lang="ts">
  export let data: Array<{ date: string; reservations: number; signups: number }>

  const WIDTH = 640
  const HEIGHT = 240
  const PAD = { top: 12, right: 12, bottom: 28, left: 32 }
  const SERIES = [
    { key: 'reservations', label: 'Bookings made', color: '#630031' },
    { key: 'signups', label: 'New accounts', color: '#e5751f' },
  ] as const

  $: top = Math.max(4, ...data.map((day) => Math.max(day.reservations, day.signups)))
  // Round the axis up to a tidy multiple so gridlines land on whole numbers.
  $: step = Math.ceil(top / 4)
  $: max = step * 4
  $: ticks = [0, 1, 2, 3, 4].map((index) => index * step)
  $: plotWidth = WIDTH - PAD.left - PAD.right
  $: plotHeight = HEIGHT - PAD.top - PAD.bottom
  $: slot = data.length > 0 ? plotWidth / data.length : plotWidth
  $: barWidth = Math.max(3, Math.min(14, slot / 2 - 2))

  const y = (value: number, maxValue: number, height: number) => PAD.top + height - (value / maxValue) * height
  const total = (rows: typeof data, key: 'reservations' | 'signups') => rows.reduce((sum, day) => sum + day[key], 0)

  function dayLabel(date: string): string {
    const [, month, day] = date.split('-')
    return `${Number(month)}/${Number(day)}`
  }
</script>

<figure class="chart">
  <div class="chart-legend">
    {#each SERIES as series}
      <span><i style={`background:${series.color}`}></i>{series.label} ({total(data, series.key)})</span>
    {/each}
  </div>

  <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Bookings made and new accounts over the last {data.length} days">
    {#each ticks as tick}
      <line class="chart-grid" x1={PAD.left} x2={WIDTH - PAD.right} y1={y(tick, max, plotHeight)} y2={y(tick, max, plotHeight)} />
      <text class="chart-axis" x={PAD.left - 6} y={y(tick, max, plotHeight) + 4} text-anchor="end">{tick}</text>
    {/each}

    {#each data as day, index}
      {@const center = PAD.left + slot * index + slot / 2}
      {#each SERIES as series, seriesIndex}
        {@const value = day[series.key]}
        {@const top = y(value, max, plotHeight)}
        <rect
          x={center + (seriesIndex === 0 ? -barWidth - 1 : 1)}
          y={top}
          width={barWidth}
          height={Math.max(value > 0 ? 2 : 0, PAD.top + plotHeight - top)}
          rx="2"
          fill={series.color}
        >
          <title>{dayLabel(day.date)} — {series.label}: {value}</title>
        </rect>
      {/each}
      {#if index % 2 === (data.length - 1) % 2}
        <text class="chart-axis" x={center} y={HEIGHT - 8} text-anchor="middle">{dayLabel(day.date)}</text>
      {/if}
    {/each}
  </svg>
</figure>
