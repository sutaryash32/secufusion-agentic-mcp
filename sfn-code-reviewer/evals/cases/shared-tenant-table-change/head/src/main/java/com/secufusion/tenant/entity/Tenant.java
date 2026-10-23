package com.secufusion.tenant.entity;

import jakarta.persistence.*;
import lombok.Data;

@Data
@Entity
@Table(name = "tenant")
public class Tenant {
    @Id private String id;
    @Column(name = "display_name", nullable = false) private String displayName;
    @Column(name = "parent_id") private String parentId;
    @Column(name = "status", nullable = false) private String status;
}
