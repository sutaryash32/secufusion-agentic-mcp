package com.secufusion.tenant.service;

import org.springframework.stereotype.Service;

@Service
public class TenantNameService {
    public String displayName(String raw) {
        if (raw == null) return "";
        return raw.trim().replaceAll("\\s+", " ");
    }

    public String slug(String raw) {
        if (raw == null) return "";
        return raw.trim().replaceAll("\\s+", " ").toLowerCase().replace(' ', '-');
    }
}
