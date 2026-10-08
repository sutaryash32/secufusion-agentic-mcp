export function parseSecurity(filePath, fileContent, repository) {
    const contexts = [];
    if (fileContent.includes('KeycloakWebSecurityConfigurerAdapter') || fileContent.includes('keycloak.json')) {
        contexts.push({ authType: 'Keycloak', filePath, repository });
    }
    if (fileContent.includes('@PreAuthorize') || fileContent.includes('@RolesAllowed')) {
        contexts.push({ authType: 'SpringSecurity-RBAC', filePath, repository });
    }
    if (fileContent.includes('jwt') || fileContent.includes('jsonwebtoken') || fileContent.includes('JwtDecoder')) {
        contexts.push({ authType: 'JWT', filePath, repository });
    }
    if (fileContent.includes('passport.use')) {
        contexts.push({ authType: 'PassportJS', filePath, repository });
    }
    return contexts;
}
