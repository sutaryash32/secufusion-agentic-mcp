package com.secufusion.iam.repository;

import com.secufusion.iam.entity.UserGroup;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface UserGroupRepository extends JpaRepository<UserGroup, String> {
    List<UserGroup> findByTenantId(String tenantId);

    @Query("select g from UserGroup g where lower(g.name) like lower(concat('%', :q, '%'))")
    List<UserGroup> searchByName(@Param("q") String q);
}
