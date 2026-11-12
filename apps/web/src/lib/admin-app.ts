/**
 * The admin app is a separate site (admin.chumbaq.com in production). The customer app
 * only ever links to it. `?.` because the logic checks load this outside Vite, where
 * `import.meta.env` does not exist; Vite replaces it in the app. The localhost fallback
 * is for dev only: a production build refuses to run on it (`admin-app-build.ts`).
 */
export const ADMIN_APP_URL: string = (
  (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_ADMIN_APP_URL || 'https://localhost:5174'
).replace(/\/+$/, '');

/** Where a view-as tab goes when its session ends: that tenant's page in the admin app. */
export function adminTenantUrl(tenantId: string): string {
  return `${ADMIN_APP_URL}/tenants/${encodeURIComponent(tenantId)}`;
}
