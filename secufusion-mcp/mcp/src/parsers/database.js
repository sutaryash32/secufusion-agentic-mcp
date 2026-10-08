export function parseDatabase(filePath, fileContent, repository) {
    const entities = [];
    if (filePath.endsWith('.sql')) {
        const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s\(]+)/gi;
        let match;
        while ((match = tableRegex.exec(fileContent)) !== null) {
            entities.push({
                tableName: match[1],
                filePath,
                repository,
                schemaType: 'SQL'
            });
        }
    }
    else if (filePath.endsWith('.prisma')) {
        const modelRegex = /model\s+(\w+)\s+\{/g;
        let match;
        while ((match = modelRegex.exec(fileContent)) !== null) {
            entities.push({
                tableName: match[1],
                filePath,
                repository,
                schemaType: 'Prisma'
            });
        }
    }
    else if (fileContent.includes('new mongoose.Schema')) {
        const modelRegex = /mongoose\.model\s*\(\s*['"]([^'"]+)['"]/g;
        let match;
        while ((match = modelRegex.exec(fileContent)) !== null) {
            entities.push({
                tableName: match[1],
                filePath,
                repository,
                schemaType: 'Mongoose'
            });
        }
    }
    return entities;
}
