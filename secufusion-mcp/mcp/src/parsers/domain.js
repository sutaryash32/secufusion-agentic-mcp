export function parseDomainModels(filePath, fileContent, repository) {
    const models = [];
    const classMatch = fileContent.match(/public\s+class\s+(\w+)/);
    if (!classMatch)
        return models;
    const className = classMatch[1];
    const violations = [];
    if (fileContent.includes("@Entity")) {
        if (!fileContent.includes("tenantId") && !fileContent.includes("TenantId")) {
            violations.push("P1 Violation: Entity is missing 'tenantId' field for tenant isolation.");
        }
        models.push({ name: className, type: "Entity", filePath, repository, violations });
    }
    if (className.endsWith("DTO") || className.endsWith("Dto") || className.endsWith("Request") || className.endsWith("Response")) {
        if (!fileContent.includes("@Data") || !fileContent.includes("@Builder")) {
            violations.push("Warning: DTO is missing @Data or @Builder Lombok annotations.");
        }
        models.push({ name: className, type: "DTO", filePath, repository, violations });
    }
    return models;
}
