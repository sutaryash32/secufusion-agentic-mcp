package com.secufusion.iam.controller;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/iam/groups")
public class GroupResetController {

    @PostMapping("/reset")
    public String reset(@RequestParam String groupId) {
        return groupId;
    }
}
