export const UI_PREVIEW_ACCESS_TOKEN = 'omni-ui-preview-token';

export const UI_PREVIEW_ORGANIZATION = {
  id: 'preview-org',
  name: 'Cửa hàng demo',
  slug: 'cua-hang-demo',
  role: 'owner' as const,
};

/**
 * Local-only UI preview mode.
 *
 * It is enabled explicitly by the `pnpm run dev:ui` helper so the normal local
 * auth flow remains available. The production bundle can never enable it, and
 * the hostname check prevents using it from a deployed/staging host even when
 * someone accidentally sets the env var.
 */
export function isUiPreviewEnabled(): boolean {
  if (process.env.NODE_ENV !== 'development') {
    return false;
  }

  if (process.env.NEXT_PUBLIC_UI_PREVIEW !== 'true') {
    return false;
  }

  if (typeof window === 'undefined') {
    return true;
  }

  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(
    window.location.hostname,
  );
}
