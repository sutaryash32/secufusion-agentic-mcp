export interface ApiEndpoint {
  controllerName: string;
  endpoints: string[];
  filePath: string;
  repository: string;
  violations: string[];
}

export function parseApiEndpoints(filePath: string, fileContent: string, repository: string): ApiEndpoint[] {
  const apis: ApiEndpoint[] = [];

  if (!fileContent.includes("@RestController")) return apis;

  const classMatch = fileContent.match(/public\s+class\s+(\w+)/);
  if (!classMatch) return apis;

  const controllerName = classMatch[1];
  const endpoints: string[] = [];
  const violations: string[] = [];

  const mappingRegex = /@(Get|Post|Put|Delete)Mapping\s*\(\s*["']([^"']+)["']\s*\)/g;
  let match;
  while ((match = mappingRegex.exec(fileContent)) !== null) {
    endpoints.push(`${match[1].toUpperCase()} ${match[2]}`);
  }

  if (!fileContent.includes("ResponseDto")) {
    violations.push("Violation: Controller methods should return ResponseEntity<ResponseDto<T>>.");
  }

  if (endpoints.length > 0 && !fileContent.includes("String tenantId")) {
    violations.push("P1 Violation: API endpoints must explicitly accept a String tenantId parameter.");
  }

  apis.push({
    controllerName,
    endpoints,
    filePath,
    repository,
    violations
  });

  return apis;
}
