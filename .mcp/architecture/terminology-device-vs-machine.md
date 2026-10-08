---
id: "terminology-device-vs-machine"
title: "Device vs Machine terminology"
category: architecture
status: accepted
tags: ["terminology","device","machine","browser","endpoint","legacy-naming"]
applies_to: ["device","machine","browser","endpoint","*Device*","*Machine*"]
source: "Migrated from .agents/AGENTS.md ('CRITICAL: Device vs Machine terminology'), authored by the SecuFusion team"
date: 2026-10-08
supersedes: []
---

# Device vs Machine terminology

This distinction has caused production bugs and engineering confusion. Every engine must know it.

| Term | Means | Example |
|---|---|---|
| **Device** | A **browser installation** | Chrome on a laptop, Edge on a workstation |
| **Machine** | A **physical endpoint** | Laptop, desktop, workstation, PC |

**Historical problem:** The platform originally used "Device" to mean physical endpoint. This
caused ambiguity — engineers, POs, and customers all read "device" as a physical machine.

A terminology correction was introduced across backend services and data models. However:
- **Older code may still use legacy "Device" naming** even when the concept is physically a Machine
- **DB schemas, event payloads, and older APIs** may not yet reflect the corrected terminology
- **UI labels are intentionally normalized** — they may say "endpoint" or "device" for UX reasons
  even when the underlying backend entity is a Machine

**Rules for every engine:**

1. Before declaring a bug involving a "device": determine whether the subject is a Browser (Device)
   or Physical Endpoint (Machine). They are different entities with different ownership models.

2. When reading backend code, DB schemas, API contracts, event payloads, or migration scripts:
   - "Device" often = browser install (unless proven otherwise by context)
   - "Machine" = physical endpoint
   - Naming inconsistency ≠ bug — it may be legacy terminology, not a defect

3. Frontend labels do NOT map 1:1 to backend entity names. Always trace the API contract and
   payload before concluding a data mismatch exists.

4. Never propose a rename or terminology fix without first confirming:
   - Which entity is actually being referenced in that specific file/layer
   - Whether the inconsistency is legacy naming or an actual modelling error
