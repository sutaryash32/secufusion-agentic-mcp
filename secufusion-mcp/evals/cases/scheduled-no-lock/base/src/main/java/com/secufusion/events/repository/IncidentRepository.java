package com.secufusion.events.repository;

import com.secufusion.events.entity.Incident;
import java.time.Instant;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

public interface IncidentRepository extends JpaRepository<Incident, String> {
    List<Incident> findByStatusAndCreatedAtBefore(String status, Instant before);
}
