export function parseNodeApis(filePath, fileContent, repository) {
    const apis = [];
    if (!filePath.endsWith('.ts') && !filePath.endsWith('.js'))
        return apis;
    const endpoints = [];
    const expressRegex = /app\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = expressRegex.exec(fileContent)) !== null) {
        endpoints.push(`${match[1].toUpperCase()} ${match[2]}`);
    }
    const nestjsRegex = /@(Get|Post|Put|Delete|Patch)\s*\(\s*['"]?([^'"]*)['"]?\s*\)/g;
    while ((match = nestjsRegex.exec(fileContent)) !== null) {
        endpoints.push(`${match[1].toUpperCase()} ${match[2]}`);
    }
    if (endpoints.length > 0) {
        const controllerMatch = fileContent.match(/export\s+class\s+(\w+Controller)/);
        const controllerName = controllerMatch ? controllerMatch[1] : filePath.split(/[\\/]/).pop()?.replace(/\.(js|ts)$/, '') || 'NodeRoute';
        apis.push({
            controllerName,
            endpoints,
            filePath,
            repository
        });
    }
    return apis;
}
