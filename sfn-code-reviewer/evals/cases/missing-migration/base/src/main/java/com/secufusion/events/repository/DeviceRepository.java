package com.secufusion.events.repository;

import com.secufusion.events.entity.Device;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface DeviceRepository extends JpaRepository<Device, String> {
    Optional<Device> findByIdAndTenantId(String id, String tenantId);
}
