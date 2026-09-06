<script lang="ts">
  let { class: className = "" }: { class?: string } = $props();
</script>

<svg class={className} viewBox="0 0 40 40" aria-hidden="true" focusable="false">
  <rect x="2" y="2" width="36" height="36" rx="4" fill="currentColor" />
  <path
    d="m11 13 7 7-7 7m12 0h6"
    fill="none"
    stroke="var(--canvas)"
    stroke-width="2"
    stroke-linecap="square"
    stroke-linejoin="miter"
  />
</svg>
