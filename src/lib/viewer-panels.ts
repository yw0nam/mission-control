/**
 * Panels a non-admin (tenant viewer) may see. Each one reads the viewer's OWN pod
 * over the gateway WebSocket (re-sourced or pod-native), never host/admin APIs.
 * Used by the nav rail (hide everything else) and the panel router (bounce
 * deep-links to excluded panels). See
 * docs/superpowers/specs/2026-06-29-viewer-nav-expansion-design.md.
 */
export const VIEWER_VISIBLE_PANELS = new Set<string>([
  'my-instance',
  'chat',
  'skills',
  'channels',
  'cron',
  'logs',
  'cost-tracker',
  'overview',
  'monitor',
  'settings',
  'agents',
])
