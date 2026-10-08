<script lang="ts">
  import { onMount } from 'svelte'

  type HealthReport = {
    ok: boolean
    environment: string
    database: string
    deployment?: string
  }

  type SmokeReport = {
    ok: boolean
    environment: string
    session: {
      configured: boolean
      verified: boolean
    }
    r2: {
      key: string
      expected: string
      actual: string | null
      ok: boolean
    }
    sql: {
      query: string
      row: {
        message: string
        created_at: string
      } | null
      ok: boolean
    }
  }

  type SmokeConfig = {
    key: string
    expectedValue: string
  }

  const SMOKE_CONFIG: Record<string, SmokeConfig> = {
    dev: {
      key: 'dev-smoke/campusconnect.txt',
      expectedValue: 'CampusConnect dev R2 smoke payload',
    },
    production: {
      key: 'prod-smoke/campusconnect.txt',
      expectedValue: 'CampusConnect production R2 smoke payload',
    },
  }

  let health: HealthReport | null = null
  let report: SmokeReport | null = null
  let loading = true
  let error = ''

  $: environmentLabel = health?.environment === 'production'
    ? 'production'
    : health?.environment === 'dev'
      ? 'local dev'
      : 'checking environment'

  async function fetchHealth(): Promise<HealthReport> {
    const response = await fetch('/api/health')
    const payload = await response.json() as HealthReport & { error?: string }

    if (!response.ok) {
      throw new Error(payload.error ?? 'The Worker health check failed')
    }

    health = payload
    return payload
  }

  async function fetchSmokeReport(environment: string) {
    const smokeConfig = SMOKE_CONFIG[environment]
    if (!smokeConfig) {
      throw new Error(`Unsupported Worker environment: ${environment}`)
    }

    const response = await fetch(`/api/integration-smoke?key=${encodeURIComponent(smokeConfig.key)}`)
    const payload = await response.json() as SmokeReport & { error?: string }

    if (!response.ok) {
      throw new Error(payload.error ?? 'The integration smoke test failed')
    }

    report = payload
  }

  async function refreshPage() {
    loading = true
    error = ''
    health = null
    report = null

    try {
      const currentHealth = await fetchHealth()
      await fetchSmokeReport(currentHealth.environment)
    } catch (requestError) {
      error = requestError instanceof Error ? requestError.message : 'The integration smoke test failed'
    } finally {
      loading = false
    }
  }

  onMount(refreshPage)
</script>

<svelte:head>
  <title>CampusConnect {environmentLabel}</title>
</svelte:head>

<main class="dashboard">
  <header class="hero">
    <p class="eyebrow">CampusConnect / {environmentLabel}</p>
    <h1>{health?.environment === 'production' ? 'Production integration check' : 'Distributed systems smoke test'}</h1>
    <p class="lede">
      {#if health?.environment === 'production'}
        This page reads an object from the production R2 bucket and a row from the Neon production database.
      {:else}
        This page reads an object from the dev R2 bucket and a row from the Neon dev database.
      {/if}
    </p>
    <button type="button" on:click={refreshPage} disabled={loading}>
      {loading ? 'Checking…' : 'Check again'}
    </button>
  </header>

  {#if loading}
    <section class="panel pending">
      <p>Contacting the {environmentLabel} Worker…</p>
    </section>
  {:else if error}
    <section class="panel failure">
      <h2>Integration check failed</h2>
      <p>{error}</p>
      {#if health?.environment === 'production'}
        <p class="hint">Run <code>npm run r2:smoke:put:production</code> if the production R2 object has not been uploaded.</p>
      {:else}
        <p class="hint">Run <code>npm run r2:smoke:put</code> if the dev R2 object has not been uploaded.</p>
      {/if}
    </section>
  {:else if report}
    <section class:success={report.ok} class:failure={!report.ok} class="panel summary">
      <div>
        <p class="eyebrow">Overall result</p>
        <h2>{report.ok ? 'R2 and database connected' : 'A check needs attention'}</h2>
        <p>Worker environment: <code>{report.environment}</code></p>
        {#if health?.deployment}
          <p>Deployment marker: <code>{health.deployment}</code></p>
        {/if}
      </div>
      <span class="status">{report.ok ? 'PASS' : 'FAIL'}</span>
    </section>

    <section class="checks">
      <article class:success={report.session.verified} class:failure={!report.session.verified} class="panel">
        <p class="eyebrow">Session secret</p>
        <h2>{report.session.verified ? 'HMAC verification passed' : 'Secret check failed'}</h2>
        <p>
          {report.session.configured
            ? `The ${report.environment} Worker loaded SESSION_SECRET without exposing its value.`
            : `SESSION_SECRET is not configured for the ${report.environment} Worker.`}
        </p>
      </article>

      <article class:success={report.r2.ok} class:failure={!report.r2.ok} class="panel">
        <p class="eyebrow">Cloudflare R2 / {report.environment}</p>
        <h2>{report.r2.ok ? 'Object read successfully' : 'Object mismatch or missing'}</h2>
        <dl>
          <dt>Hard-coded key</dt>
          <dd><code>{report.r2.key}</code></dd>
          <dt>Expected value</dt>
          <dd>{report.r2.expected}</dd>
          <dt>Retrieved value</dt>
          <dd>{report.r2.actual ?? 'Object not found'}</dd>
        </dl>
      </article>

      <article class:success={report.sql.ok} class:failure={!report.sql.ok} class="panel">
        <p class="eyebrow">Neon {report.environment} database</p>
        <h2>{report.sql.ok ? 'SQL query returned a row' : 'SQL query returned no row'}</h2>
        <p class="label">Query executed</p>
        <pre><code>{report.sql.query}</code></pre>
        <p class="label">Query result</p>
        <pre><code>{JSON.stringify(report.sql.row, null, 2)}</code></pre>
      </article>
    </section>
  {/if}
</main>
