package com.secufusion.iam.entity;

import jakarta.persistence.*;
import lombok.Data;

@Data
@Entity
@Table(name = "user_group")
public class UserGroup {
    @Id private String id;
    @Column(name = "tenant_id", nullable = false) private String tenantId;
    @Column(name = "name") private String name;
}
