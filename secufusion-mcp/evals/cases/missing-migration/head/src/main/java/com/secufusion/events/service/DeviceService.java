package com.secufusion.events.service;

import com.secufusion.events.entity.Device;
import com.secufusion.events.repository.DeviceRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
public class DeviceService {
    private final DeviceRepository deviceRepository;

    public Device touch(String tenantId, String deviceId, String ip) {
        Device d = deviceRepository.findByIdAndTenantId(deviceId, tenantId).orElseThrow();
        d.setLastSeenIp(ip);
        return deviceRepository.save(d);
    }

    public Device rename(String tenantId, String deviceId, String name) {
        Device d = deviceRepository.findByIdAndTenantId(deviceId, tenantId).orElseThrow();
        d.setDeviceName(name);
        return deviceRepository.save(d);
    }
}
