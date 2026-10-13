<script lang="ts">
  import { onMount } from 'svelte'

  type PublicUser = {
    userId: number
    username: string
    email: string
    phoneNumber: string | null
    role: string
    createdAt: string
    creditBalance: number
    creditLastReset: string
    emailNotificationsOn: boolean
    textNotificationsOn: boolean
  }

  type ApiError = {
    error?: string
    fieldErrors?: Record<string, string>
  }

  let user: PublicUser | null = null
  let loading = true
  let submitting = false
  let message = ''
  let error = ''
  let fieldErrors: Record<string, string> = {}

  let loginIdentifier = ''
  let loginPassword = ''
  let signupUsername = ''
  let signupEmail = ''
  let signupPassword = ''
  let signupConfirmPassword = ''
  let signupPhoneNumber = ''

  function clearFeedback() {
    message = ''
    error = ''
    fieldErrors = {}
  }

  async function responsePayload(response: Response): Promise<ApiError & { user?: PublicUser }> {
    try {
      return await response.json() as ApiError & { user?: PublicUser }
    } catch {
      return {}
    }
  }

  async function loadCurrentUser() {
    loading = true

    try {
      const response = await fetch('/api/auth/me')
      const payload = await responsePayload(response)

      if (response.ok && payload.user) {
        user = payload.user
      } else if (response.status === 401) {
        user = null
      } else {
        error = payload.error ?? 'Unable to check your session.'
      }
    } catch {
      error = 'Unable to connect to CampusConnect.'
    } finally {
      loading = false
    }
  }

  async function login() {
    clearFeedback()
    submitting = true

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: loginIdentifier, password: loginPassword }),
      })
      const payload = await responsePayload(response)

      if (!response.ok || !payload.user) {
        error = payload.error ?? 'Unable to sign in.'
        return
      }

      user = payload.user
      loginPassword = ''
      message = 'You are signed in.'
    } catch {
      error = 'Unable to connect to CampusConnect.'
    } finally {
      submitting = false
    }
  }

  async function signup() {
    clearFeedback()
    submitting = true

    try {
      const response = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: signupUsername,
          email: signupEmail,
          password: signupPassword,
          confirmPassword: signupConfirmPassword,
          phoneNumber: signupPhoneNumber,
        }),
      })
      const payload = await responsePayload(response)

      if (!response.ok || !payload.user) {
        error = payload.error ?? 'Unable to create your account.'
        fieldErrors = payload.fieldErrors ?? {}
        return
      }

      user = payload.user
      signupPassword = ''
      signupConfirmPassword = ''
      message = 'Your account has been created.'
    } catch {
      error = 'Unable to connect to CampusConnect.'
    } finally {
      submitting = false
    }
  }

  async function logout() {
    clearFeedback()
    submitting = true

    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' })
      const payload = await responsePayload(response)

      if (!response.ok) {
        error = payload.error ?? 'Unable to sign out.'
        return
      }

      user = null
      message = 'You have been signed out.'
    } catch {
      error = 'Unable to connect to CampusConnect.'
    } finally {
      submitting = false
    }
  }

  onMount(loadCurrentUser)
</script>

<svelte:head>
  <title>CampusConnect</title>
  <meta name="description" content="CampusConnect campus resource reservations" />
</svelte:head>

<main class="auth-shell">
  <header class="hero">
    <p class="eyebrow">CampusConnect / Virginia Tech</p>
    <h1>Share space. Find your place.</h1>
    <p class="lede">
      Reserve useful campus resources with the Virginia Tech community.
    </p>
  </header>

  {#if loading}
    <section class="panel pending" aria-live="polite">
      <p>Checking your session…</p>
    </section>
  {:else if user}
    <section class="panel profile-card">
      <div class="profile-heading">
        <div>
          <p class="eyebrow">Your profile</p>
          <h2>Welcome, {user.username}</h2>
          <p class="muted">Your account is ready to use CampusConnect.</p>
        </div>
        <button type="button" class="secondary-button" on:click={logout} disabled={submitting}>
          {submitting ? 'Signing out…' : 'Sign out'}
        </button>
      </div>

      <dl class="profile-details">
        <div><dt>Email</dt><dd>{user.email}</dd></div>
        <div><dt>Phone</dt><dd>{user.phoneNumber ?? 'Not provided'}</dd></div>
        <div><dt>Account type</dt><dd>{user.role}</dd></div>
        <div><dt>Credits</dt><dd>{user.creditBalance}</dd></div>
        <div><dt>Joined</dt><dd>{new Date(user.createdAt).toLocaleDateString()}</dd></div>
        <div><dt>Email notifications</dt><dd>{user.emailNotificationsOn ? 'On' : 'Off'}</dd></div>
      </dl>
    </section>
  {:else}
    {#if message}
      <p class="notice success-notice" role="status">{message}</p>
    {/if}
    {#if error}
      <p class="notice error-notice" role="alert">{error}</p>
    {/if}

    <section class="auth-grid">
      <section class="panel auth-card">
        <p class="eyebrow">Step 1</p>
        <h2>Log in</h2>
        <p class="muted">Use your CampusConnect username or Virginia Tech email.</p>

        <form on:submit|preventDefault={login}>
          <label>
            Username or email
            <input bind:value={loginIdentifier} autocomplete="username" required />
          </label>
          <label>
            Password
            <input type="password" bind:value={loginPassword} autocomplete="current-password" required />
          </label>
          <button type="submit" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>

      <section class="panel auth-card">
        <p class="eyebrow">Step 2</p>
        <h2>Create an account</h2>
        <p class="muted">Only Virginia Tech students and faculty with a <code>@vt.edu</code> email can join.</p>

        <form on:submit|preventDefault={signup}>
          <label>
            Username
            <input bind:value={signupUsername} autocomplete="username" minlength="3" maxlength="32" required />
            {#if fieldErrors.username}<span class="field-error">{fieldErrors.username}</span>{/if}
          </label>
          <label>
            VT email
            <input type="email" bind:value={signupEmail} autocomplete="email" maxlength="254" required />
            {#if fieldErrors.email}<span class="field-error">{fieldErrors.email}</span>{/if}
          </label>
          <label>
            Password
            <input type="password" bind:value={signupPassword} autocomplete="new-password" minlength="8" maxlength="128" required />
            {#if fieldErrors.password}<span class="field-error">{fieldErrors.password}</span>{/if}
          </label>
          <label>
            Confirm password
            <input type="password" bind:value={signupConfirmPassword} autocomplete="new-password" required />
            {#if fieldErrors.confirmPassword}<span class="field-error">{fieldErrors.confirmPassword}</span>{/if}
          </label>
          <label>
            Phone number <span class="optional">optional</span>
            <input type="tel" bind:value={signupPhoneNumber} autocomplete="tel" maxlength="16" />
            {#if fieldErrors.phoneNumber}<span class="field-error">{fieldErrors.phoneNumber}</span>{/if}
          </label>
          <button type="submit" disabled={submitting}>
            {submitting ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <p class="safety-note">
          Please do not share sensitive information such as passwords, financial details, or government identification in resource descriptions, reviews, or messages.
        </p>
      </section>
    </section>
  {/if}
</main>
