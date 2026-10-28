<script lang="ts">
  export let route: { label: string; description: string }
</script>

<section class="panel placeholder-card">
  <p class="eyebrow">Coming soon</p>
  <h2>{route.label}</h2>
  <p class="muted">{route.description}</p>
</section>
