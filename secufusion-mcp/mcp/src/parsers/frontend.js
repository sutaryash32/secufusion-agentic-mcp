export function parseFrontend(filePath, fileContent, repository) {
    const components = [];
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) {
        const match = fileContent.match(/(?:export\s+)?(?:default\s+)?(?:function|const)\s+([A-Z]\w+)/);
        if (match) {
            components.push({
                componentName: match[1],
                type: 'React',
                filePath,
                repository
            });
        }
    }
    else if (filePath.endsWith('.vue')) {
        components.push({
            componentName: filePath.split('/').pop()?.replace('.vue', '') || 'VueComponent',
            type: 'Vue',
            filePath,
            repository
        });
    }
    else if (filePath.endsWith('.ts') && fileContent.includes('@Component')) {
        const match = fileContent.match(/export\s+class\s+(\w+Component)/);
        if (match) {
            components.push({
                componentName: match[1],
                type: 'Angular',
                filePath,
                repository
            });
        }
    }
    return components;
}
