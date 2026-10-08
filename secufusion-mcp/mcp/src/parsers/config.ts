export interface ConfigEntry {
  key: string;
  value: string;
  requiresRealValues: boolean;
}

export interface ConfigurationFile {
  filePath: string;
  repository: string;
  entries: ConfigEntry[];
  hasMaskedValues: boolean;
}

export function parseConfig(filePath: string, fileContent: string, repository: string): ConfigurationFile[] {
  const isEnv = filePath.includes('.env');
  const isProperties = filePath.endsWith('.properties');
  const isYaml = filePath.endsWith('.yml') || filePath.endsWith('.yaml');

  if (!isEnv && !isProperties && !isYaml) return [];

  const config: ConfigurationFile = {
    filePath,
    repository,
    entries: [],
    hasMaskedValues: false
  };

  const lines = fileContent.split('\n');

  if (isEnv || isProperties) {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const splitIdx = trimmed.indexOf('=');
      if (splitIdx > 0) {
        const key = trimmed.substring(0, splitIdx).trim();
        const value = trimmed.substring(splitIdx + 1).trim();
        
        const requiresRealValues = 
          filePath.includes('.example') || 
          value === '' || 
          value.includes('***') || 
          value.toLowerCase().includes('changeme') || 
          value.startsWith('${') || 
          value.startsWith('<');

        config.entries.push({ key, value, requiresRealValues });
        if (requiresRealValues) config.hasMaskedValues = true;
      }
    }
  } else if (isYaml) {
    // Simple parsing for Spring Boot application.yml and similar config keys
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      const match = trimmed.match(/^([\w-]+):\s*(.*)$/);
      if (match) {
        const key = match[1];
        const value = match[2];
        if (value && value !== '{' && value !== '[') {
            const requiresRealValues = value.includes('***') || value.toLowerCase().includes('changeme') || value.startsWith('${');
            config.entries.push({ key, value, requiresRealValues });
            if (requiresRealValues) config.hasMaskedValues = true;
        }
      }
    }
  }

  if (config.entries.length > 0) {
    return [config];
  }
  return [];
}

export function parseExternalEnv(fileContent: string): Record<string, string> {
  const values: Record<string, string> = {};
  const lines = fileContent.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const splitIdx = trimmed.indexOf('=');
    if (splitIdx > 0) {
      const key = trimmed.substring(0, splitIdx).trim();
      const value = trimmed.substring(splitIdx + 1).trim();
      values[key] = value;
    }
  }
  return values;
}
