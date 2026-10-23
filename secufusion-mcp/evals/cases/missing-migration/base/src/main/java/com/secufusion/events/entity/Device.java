package com.secufusion.events.entity;

import jakarta.persistence.*;
import lombok.Data;

@Data
@Entity
@Table(name = "devices")
public class Device {
    @Id
    private String id;

    @Column(name = "tenant_id", nullable = false)
    private String tenantId;

    @Column(name = "device_name")
    private String deviceName;

    @Column(name = "status", nullable = false)
    private String status;
}
