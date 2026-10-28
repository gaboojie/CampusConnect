<script lang="ts">
  import { onMount } from 'svelte'
  import { getJson } from '../../lib/api'
  import { adminHash } from '../../lib/adminRoutes'
  import { formatDate, formatDateTime } from '../../lib/format'
  import type { AdminUserDetail } from '../../lib/types'

  export let userId: string

  let user: AdminUserDetail | null = null
  let loading = true
  let error = ''

  onMount(async () => {
    try {
      user = (await getJson<{ user: AdminUserDetail }>(`/api/admin/users/${userId}`)).user
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Unable to load this user.'
    } finally {
      loading = false
    }
  })

  const yesNo = (value: boolean) => (value ? 'Yes' : 'No')
  const onOff = (value: boolean) => (value ? 'On' : 'Off')
</script>

<section class="admin-page">
  <a class="back-link" href={adminHash('users')}>← All users</a>

  {#if loading}
    <div class="panel"><p class="muted">Loading user…</p></div>
  {:else if error}
    <p class="notice error-notice" role="alert">{error}</p>
  {:else if user}
    <div class="panel profile-card">
      <div class="profile-heading">
        <div>
          <p class="eyebrow">User #{user.userId}</p>
          <h2>{user.username}</h2>
          <p class="muted">{user.email}</p>
        </div>
        <span class={`badge user-status-${user.status}`}>{user.status}</span>
      </div>

      <dl class="profile-details">
        <div><dt>Role</dt><dd>{user.role}</dd></div>
        <div><dt>Phone</dt><dd>{user.phoneNumber ?? 'Not provided'}</dd></div>
        <div><dt>Joined</dt><dd>{formatDateTime(user.createdAt.slice(0, 19))}</dd></div>
        <div><dt>Email verified</dt><dd>{user.emailVerifiedAt ? formatDateTime(user.emailVerifiedAt.slice(0, 19)) : 'Not verified'}</dd></div>
        <div><dt>Credits</dt><dd>{user.creditBalance}</dd></div>
        <div><dt>Credits last reset</dt><dd>{formatDate(user.creditLastReset)}</dd></div>
        <div><dt>Can add resources</dt><dd>{yesNo(user.canAddResources)}</dd></div>
        <div><dt>Banned</dt><dd>{yesNo(user.isBanned)}</dd></div>
        <div><dt>Email notifications</dt><dd>{onOff(user.emailNotificationsOn)}</dd></div>
        <div><dt>SMS notifications</dt><dd>{onOff(user.textNotificationsOn)}</dd></div>
        <div><dt>Resources owned</dt><dd>{user.resourcesOwned}</dd></div>
        <div>
          <dt>Reservations</dt>
          <dd>
            {#each Object.entries(user.reservationCounts) as [status, count]}
              <span class={`badge status-${status}`}>{status}: {count}</span>{' '}
            {:else}
              None
            {/each}
          </dd>
        </div>
      </dl>
    </div>
  {/if}
</section>
