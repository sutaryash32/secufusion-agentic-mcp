package com.secufusion.iam.security;

import java.util.Set;

public final class MutatingEndpointAllowlist {
    /** Mutating handlers that are deliberately not scope-gated (public / self-service). */
    static final Set<String> ALLOWED = Set.of(
        "AuthController#login"
    );
}
