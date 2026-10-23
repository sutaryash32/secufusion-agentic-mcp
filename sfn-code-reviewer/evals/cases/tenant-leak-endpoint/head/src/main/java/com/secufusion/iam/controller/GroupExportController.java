package com.secufusion.iam.controller;

import com.secufusion.iam.entity.UserGroup;
import com.secufusion.iam.repository.UserGroupRepository;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/iam/groups")
@RequiredArgsConstructor
public class GroupExportController {

    private final UserGroupRepository userGroupRepository;

    public record ExportRequest(String tenantId) {}

    /** Export all groups of a tenant (used by the MSSP console). */
    @PostMapping("/export")
    public List<UserGroup> export(@RequestBody ExportRequest request) {
        return userGroupRepository.findByTenantId(request.tenantId());
    }

    /** Typeahead for the group picker. */
    @GetMapping("/search")
    public List<UserGroup> search(@RequestParam String q) {
        return userGroupRepository.searchByName(q);
    }
}
