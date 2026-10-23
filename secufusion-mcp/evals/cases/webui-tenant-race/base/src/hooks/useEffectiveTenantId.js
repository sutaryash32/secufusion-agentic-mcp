import { useSelector } from 'react-redux';

/** The tenant the operator is acting as (respects MSSP "Open as me"). Use this for tenant-scoped calls. */
export function useEffectiveTenantId() {
  return useSelector((s) => s.tenant.actingTenantId ?? s.auth.currentUser?.tenantId);
}
