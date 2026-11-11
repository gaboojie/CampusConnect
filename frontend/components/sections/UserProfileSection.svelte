<script lang="ts">
  import UserReviewsSection from './UserReviewsSection.svelte'

  export let userId: string
</script>

<section class="public-profile-page">
  <a class="back-link" href="#/resources">Back to resources</a>
  <article class="panel public-profile-card">
    <UserReviewsSection {userId} />
  </article>
</section>
