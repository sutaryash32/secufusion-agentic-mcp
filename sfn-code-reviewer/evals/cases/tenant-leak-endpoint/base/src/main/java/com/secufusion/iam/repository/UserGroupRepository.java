package com.secufusion.iam.repository;

import com.secufusion.iam.entity.UserGroup;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

public interface UserGroupRepository extends JpaRepository<UserGroup, String> {
    List<UserGroup> findByTenantId(String tenantId);
}
