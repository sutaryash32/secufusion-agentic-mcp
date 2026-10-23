package com.secufusion.iam.kafka;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
public class DeviceRegistrationEvent {
    private String tenantId;
    private String deviceUuid;
    private String userEmail;
}
