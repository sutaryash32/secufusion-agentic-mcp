export function inferPatterns(dna: any): string[] {
  const inferredPatterns: string[] = [];

  // Infer DTO naming patterns
  const domains = dna.domains || [];
  if (domains.length > 0) {
    const dtos = domains.filter((d: any) => d.type === "DTO");
    if (dtos.length > 0) {
      let suffixDTO = 0;
      let suffixRequest = 0;
      let suffixResponse = 0;
      dtos.forEach((d: any) => {
        if (d.name.endsWith("DTO")) suffixDTO++;
        else if (d.name.endsWith("Request")) suffixRequest++;
        else if (d.name.endsWith("Response")) suffixResponse++;
      });

      const max = Math.max(suffixDTO, suffixRequest, suffixResponse);
      const total = dtos.length;
      if (max / total > 0.7) {
        if (max === suffixDTO) inferredPatterns.push("Inferred Pattern: 70%+ of data models use 'DTO' suffix.");
        if (max === suffixRequest) inferredPatterns.push("Inferred Pattern: 70%+ of data models use 'Request' suffix.");
        if (max === suffixResponse) inferredPatterns.push("Inferred Pattern: 70%+ of data models use 'Response' suffix.");
      }
    }
  }

  // Infer API Path Versioning
  const apis = dna.apis || [];
  if (apis.length > 0) {
    let versioned = 0;
    apis.forEach((a: any) => {
      const paths = a.endpoints.join(" ");
      if (paths.includes("/v1/") || paths.includes("/v2/")) {
        versioned++;
      }
    });
    
    if (versioned / apis.length < 0.1) {
      inferredPatterns.push("Inferred Pattern: Codebase does not heavily use URL path versioning (e.g., /v1/).");
    } else if (versioned / apis.length > 0.8) {
      inferredPatterns.push("Inferred Pattern: Codebase strictly enforces URL path versioning (e.g., /v1/).");
    }
  }

  return inferredPatterns;
}
