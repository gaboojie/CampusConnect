<script lang="ts">
  import type { AppRoute } from '../../lib/routes'

  export let route: AppRoute
</script>

<section class="panel placeholder-card">
  <p class="eyebrow">Coming soon</p>
  <h2>{route.label}</h2>
  <p class="muted">{route.description}</p>
</section>
