<script lang="ts">
  export let page: number
  export let pageSize: number
  export let total: number
  export let onChange: (page: number) => void

  $: pageCount = Math.max(1, Math.ceil(total / pageSize))
  $: first = total === 0 ? 0 : (page - 1) * pageSize + 1
  $: last = Math.min(page * pageSize, total)
</script>

<div class="pagination">
  <p class="muted">Showing {first}–{last} of {total}</p>
  <div class="pagination-buttons">
    <button type="button" class="secondary-button" disabled={page <= 1} on:click={() => onChange(page - 1)}>Previous</button>
    <span class="muted">Page {page} of {pageCount}</span>
    <button type="button" class="secondary-button" disabled={page >= pageCount} on:click={() => onChange(page + 1)}>Next</button>
  </div>
</div>
