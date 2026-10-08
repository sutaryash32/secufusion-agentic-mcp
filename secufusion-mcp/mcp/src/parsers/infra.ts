export interface InfraResource {
  type: string; // 'Docker', 'Kubernetes', 'Terraform'
  name: string;
  filePath: string;
  repository: string;
}

export function parseInfra(filePath: string, fileContent: string, repository: string): InfraResource[] {
  const resources: InfraResource[] = [];
  
  if (filePath.endsWith('docker-compose.yml') || filePath.endsWith('docker-compose.yaml')) {
     const servicesRegex = /services:\s*\n((\s+[\w-]+:\s*\n)+)/;
     const match = fileContent.match(servicesRegex);
     if (match) {
         resources.push({
             type: 'DockerCompose',
             name: 'Compose-Services',
             filePath,
             repository
         });
     }
  } else if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
     if (fileContent.includes('apiVersion:') && fileContent.includes('kind:')) {
        const kindMatch = fileContent.match(/kind:\s*(\w+)/);
        const nameMatch = fileContent.match(/name:\s*([^\n]+)/);
        if (kindMatch && nameMatch) {
            resources.push({
                type: `Kubernetes-${kindMatch[1]}`,
                name: nameMatch[1],
                filePath,
                repository
            });
        }
     }
  } else if (filePath.endsWith('.tf')) {
     const resourceRegex = /resource\s+"([^"]+)"\s+"([^"]+)"/g;
     let match;
     while ((match = resourceRegex.exec(fileContent)) !== null) {
         resources.push({
             type: `Terraform-${match[1]}`,
             name: match[2],
             filePath,
             repository
         });
     }
  }
  
  return resources;
}
