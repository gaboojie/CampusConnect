<script lang="ts">
  import type { PublicUser } from '../../lib/types'

  export let user: PublicUser
  export let submitting: boolean
  export let onLogout: () => void
</script>

<section class="panel profile-card">
  <div class="profile-heading">
    <div>
      <p class="eyebrow">Your profile</p>
      <h2>Welcome, {user.username}</h2>
      <p class="muted">Your account is ready to use CampusConnect.</p>
    </div>
    <button type="button" class="secondary-button" on:click={onLogout} disabled={submitting}>
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
