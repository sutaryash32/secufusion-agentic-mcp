package com.secufusion.tenant.service;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class TenantNameServiceTest {
    private final TenantNameService service = new TenantNameService();

    @Test
    void collapsesWhitespace() {
        assertThat(service.displayName("  Acme   Corp ")).isEqualTo("Acme Corp");
        assertThat(service.slug("  Acme   Corp ")).isEqualTo("acme-corp");
        assertThat(service.displayName(null)).isEmpty();
        assertThat(service.slug(null)).isEmpty();
    }
}
