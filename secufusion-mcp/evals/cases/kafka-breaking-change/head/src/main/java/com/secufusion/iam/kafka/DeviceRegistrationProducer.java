package com.secufusion.iam.kafka;

import lombok.RequiredArgsConstructor;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

@Component
@RequiredArgsConstructor
public class DeviceRegistrationProducer {
    public static final String DEVICE_REGISTRATION_TOPIC = "device-registration";
    private final KafkaTemplate<String, DeviceRegistrationEvent> kafkaTemplate;

    public void publish(String tenantId, String deviceUuid, String email) {
        kafkaTemplate.send(DEVICE_REGISTRATION_TOPIC, tenantId, new DeviceRegistrationEvent(tenantId, deviceUuid, email));
    }
}
