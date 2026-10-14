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
    message?: string
    fieldErrors?: Record<string, string>
  }

  let user: PublicUser | null = null
  let loading = true
  let submitting = false
  let signupOpen = false
  let verificationToken = ''
  let resendOpen = false
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
  let signupEmailNotifications = true
  let signupTextNotifications = false
  let resendEmail = ''

  function clearFeedback() {
    message = ''
    error = ''
    fieldErrors = {}
  }

  function openSignup() {
    clearFeedback()
    signupOpen = true
  }

  function closeSignup() {
    if (!submitting) {
      signupOpen = false
    }
  }

  async function responsePayload(response: Response): Promise<ApiError & { user?: PublicUser }> {
    try {
      return await response.json() as ApiError & { user?: PublicUser }
    } catch {
      return {}
    }
  }

  function readVerificationToken(): string {
    if (typeof window === 'undefined') return ''
    const match = window.location.hash.match(/^#verify=(.+)$/)
    return match ? decodeURIComponent(match[1]) : ''
  }

  function clearVerificationHash() {
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
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
          emailNotificationsOn: signupEmailNotifications,
          textNotificationsOn: signupTextNotifications,
        }),
      })
      const payload = await responsePayload(response)

      if (!response.ok) {
        error = payload.error ?? 'Unable to create your account.'
        fieldErrors = payload.fieldErrors ?? {}
        return
      }

      signupOpen = false
      resendEmail = signupEmail
      resendOpen = true
      signupPassword = ''
      signupConfirmPassword = ''
      message = payload.message ?? 'Check your Virginia Tech email before signing in.'
    } catch {
      error = 'Unable to connect to CampusConnect.'
    } finally {
      submitting = false
    }
  }

  async function verifyEmail() {
    if (!verificationToken) return

    clearFeedback()
    submitting = true

    try {
      const response = await fetch('/api/auth/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: verificationToken }),
      })
      const payload = await responsePayload(response)

      if (!response.ok) {
        error = payload.error ?? 'Unable to verify your email.'
        return
      }

      verificationToken = ''
      clearVerificationHash()
      message = payload.message ?? 'Email verified. You can sign in now.'
    } catch {
      error = 'Unable to connect to CampusConnect.'
    } finally {
      submitting = false
    }
  }

  async function resendVerification() {
    clearFeedback()
    submitting = true

    try {
      const response = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: resendEmail }),
      })
      const payload = await responsePayload(response)

      if (!response.ok) {
        error = payload.error ?? 'Unable to resend the verification email.'
        return
      }

      message = payload.message ?? 'Check your Virginia Tech email for a new verification link.'
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

  onMount(() => {
    verificationToken = readVerificationToken()
    return loadCurrentUser()
  })
</script>

<svelte:head>
  <title>CampusConnect</title>
  <meta name="description" content="CampusConnect campus resource reservations" />
</svelte:head>

<div class="site-shell">
  <header class="site-header">
    <a class="brand" href="/" aria-label="CampusConnect home">Campus Connect</a>
    <div class="account-indicator" aria-label={user ? `Signed in as ${user.username}` : 'Not signed in'}>
      <svg class="user-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="8" r="3.25" fill="none" stroke="currentColor" stroke-width="1.8" />
        <path d="M5.5 20c.7-3.7 2.9-5.5 6.5-5.5s5.8 1.8 6.5 5.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.8" />
      </svg>
      <span>{user ? user.username : 'Not signed in'}</span>
    </div>
  </header>

  <main class="auth-shell">
    <header class="hero">
      <p class="eyebrow">Virginia Tech community</p>
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
          <div><dt>SMS notifications</dt><dd>{user.textNotificationsOn ? 'On' : 'Off'}</dd></div>
        </dl>
      </section>
    {:else if verificationToken}
      <section class="panel verification-card">
        <p class="eyebrow">One last step</p>
        <h2>Confirm your email</h2>
        <p class="muted">Use this button to confirm that you control the Virginia Tech email address used for signup.</p>
        <button type="button" on:click={verifyEmail} disabled={submitting}>
          {submitting ? 'Verifying…' : 'Verify email'}
        </button>
        {#if error}
          <p class="notice error-notice" role="alert">{error}</p>
        {/if}
      </section>
    {:else}
      {#if message}
        <p class="notice success-notice" role="status">{message}</p>
      {/if}
      {#if error}
        <p class="notice error-notice" role="alert">{error}</p>
      {/if}

      <section class="panel auth-card">
        <p class="eyebrow">Welcome back</p>
        <h2>Sign in to CampusConnect</h2>
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

        <p class="register-prompt">
          Don’t have an account?
          <button type="button" class="register-link" on:click={openSignup}>Register now!</button>
        </p>

        <details class="resend-details" open={resendOpen} on:toggle={(event) => resendOpen = (event.currentTarget as HTMLDetailsElement).open}>
          <summary>Didn't receive a verification email?</summary>
          <form on:submit|preventDefault={resendVerification}>
            <label>
              VT email
              <input type="email" bind:value={resendEmail} autocomplete="email" required />
            </label>
            <button type="submit" class="secondary-button" disabled={submitting}>
              {submitting ? 'Sending…' : 'Send again'}
            </button>
          </form>
        </details>
      </section>
    {/if}
  </main>

  <footer class="site-footer">
    <p>Designed for Virginia Tech’s CS 5614 class on Database Management Systems.</p>
    <p class="footer-note">This is a toy project. Please do not include sensitive information.</p>
  </footer>
</div>

{#if signupOpen}
  <div class="modal-layer">
    <button type="button" class="modal-backdrop" aria-label="Close registration form" on:click={closeSignup}></button>
    <dialog open class="modal" aria-labelledby="signup-title">
      <div class="modal-heading">
        <div>
          <p class="eyebrow">New to CampusConnect?</p>
          <h2 id="signup-title">Create an account</h2>
        </div>
        <button type="button" class="modal-close" aria-label="Close registration form" on:click={closeSignup}>×</button>
      </div>

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

        <fieldset class="notification-options">
          <legend>Notifications</legend>
          <p class="checkbox-help">Choose how you would like to hear about reservations and important account updates.</p>
          <label class="checkbox-label">
            <input type="checkbox" bind:checked={signupEmailNotifications} />
            <span>Email notifications</span>
          </label>
          <label class="checkbox-label">
            <input type="checkbox" bind:checked={signupTextNotifications} disabled={!signupPhoneNumber.trim()} />
            <span>SMS notifications <span class="optional">requires a phone number</span></span>
          </label>
        </fieldset>

        <button type="submit" disabled={submitting}>
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>

      <p class="safety-note">
        Please do not share sensitive information such as passwords, financial details, or government identification in resource descriptions, reviews, or messages.
      </p>
    </dialog>
  </div>
{/if}
