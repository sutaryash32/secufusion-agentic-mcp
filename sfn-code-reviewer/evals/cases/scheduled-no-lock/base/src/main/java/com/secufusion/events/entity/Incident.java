package com.secufusion.events.entity;

import jakarta.persistence.*;
import java.time.Instant;
import lombok.Data;

@Data
@Entity
@Table(name = "incidents")
public class Incident {
    @Id private String id;
    @Column(name = "tenant_id", nullable = false) private String tenantId;
    @Column(name = "status", nullable = false) private String status;
    @Column(name = "created_at", nullable = false) private Instant createdAt;
}
