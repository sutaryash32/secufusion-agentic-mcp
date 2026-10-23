package com.secufusion.events.kafka;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.secufusion.events.service.DeviceProvisioningService;
import lombok.RequiredArgsConstructor;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

@Component
@RequiredArgsConstructor
public class DeviceRegistrationConsumer {
    public static final String DEVICE_REGISTRATION_TOPIC = "device-registration";
    private final ObjectMapper objectMapper;
    private final DeviceProvisioningService provisioning;

    @KafkaListener(topics = DEVICE_REGISTRATION_TOPIC, groupId = "events-api")
    public void onMessage(String payload) throws Exception {
        JsonNode node = objectMapper.readTree(payload);
        String tenantId = node.get("tenantId").asText();
        String deviceId = node.get("deviceId").asText();
        provisioning.ensureDevice(tenantId, deviceId, node.path("userEmail").asText(null));
    }
}
