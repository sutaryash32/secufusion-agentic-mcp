package com.secufusion.events.scheduler;

import com.secufusion.events.entity.Incident;
import com.secufusion.events.repository.IncidentRepository;
import com.secufusion.events.service.MailService;
import java.time.Duration;
import java.time.Instant;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Slf4j
@Component
@RequiredArgsConstructor
public class IncidentReminderScheduler {

    private final IncidentRepository incidentRepository;
    private final MailService mailService;

    /** Every 5 minutes: remind tenant admins about incidents open for more than 24h, once. */
    @Scheduled(fixedDelayString = "PT5M")
    public void remindStaleIncidents() {
        Instant cutoff = Instant.now().minus(Duration.ofHours(24));
        for (Incident incident : incidentRepository.findByStatusAndCreatedAtBefore("OPEN", cutoff)) {
            try {
                mailService.sendIncidentReminder(incident.getTenantId(), incident.getId());
                incident.setStatus("REMINDED");
                incidentRepository.save(incident);
            } catch (Exception e) {
                log.debug("reminder failed");
            }
        }
    }
}
