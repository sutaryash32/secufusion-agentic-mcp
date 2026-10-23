package com.secufusion.iam.entity;

import jakarta.persistence.*;
import lombok.Data;

/** Read-only view of the shared tenant table (owned by sfn-tenants-api). */
@Data
@Entity
@Table(name = "tenant")
public class Tenant {
    @Id private String id;
    @Column(name = "company_name") private String companyName;
    @Column(name = "parent_id") private String parentId;
}
