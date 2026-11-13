<script lang="ts">
  export let items: Array<{ label: string; value: number; color: string }>

  $: max = Math.max(1, ...items.map((item) => item.value))
  $: total = items.reduce((sum, item) => sum + item.value, 0)
</script>

<ul class="bar-list">
  {#each items as item}
    <li>
      <div class="bar-list-row">
        <span>{item.label}</span>
        <strong>{item.value}{#if total > 0}<small> · {Math.round((item.value / total) * 100)}%</small>{/if}</strong>
      </div>
      <div class="bar-track" role="presentation">
        <div class="bar-fill" style={`width:${(item.value / max) * 100}%;background:${item.color}`}></div>
      </div>
    </li>
  {/each}
</ul>
