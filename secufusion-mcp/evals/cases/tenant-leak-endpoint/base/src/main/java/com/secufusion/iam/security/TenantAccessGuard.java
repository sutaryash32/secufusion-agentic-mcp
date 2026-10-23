package com.secufusion.iam.security;

import org.springframework.stereotype.Component;

/** Cross-tenant guard: call requireCallerCanAccess(tenantId) for any tenant id not in a `tenantId` path var. */
@Component
public class TenantAccessGuard {
    public boolean callerCanAccess(String targetTenantId) { return false; }
    public void requireCallerCanAccess(String targetTenantId) {
        if (!callerCanAccess(targetTenantId)) throw new SecurityException("forbidden");
    }
}
