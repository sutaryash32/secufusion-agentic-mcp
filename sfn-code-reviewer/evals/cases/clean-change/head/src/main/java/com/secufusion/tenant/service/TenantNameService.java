package com.secufusion.tenant.service;

import org.springframework.stereotype.Service;

@Service
public class TenantNameService {
    public String displayName(String raw) {
        return collapseWhitespace(raw);
    }

    public String slug(String raw) {
        return collapseWhitespace(raw).toLowerCase().replace(' ', '-');
    }

    private static String collapseWhitespace(String raw) {
        if (raw == null) return "";
        return raw.trim().replaceAll("\\s+", " ");
    }
}
