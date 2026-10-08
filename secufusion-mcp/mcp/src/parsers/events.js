export function parseEventTopics(filePath, fileContent, repository) {
    const events = [];
    const classMatch = fileContent.match(/public\s+class\s+(\w+)/);
    if (!classMatch)
        return events;
    const className = classMatch[1];
    const topicsConsumed = [];
    const topicsProduced = [];
    const violations = [];
    const listenerRegex = /@KafkaListener\s*\(\s*topics\s*=\s*["']([^"']+)["']/g;
    let match;
    while ((match = listenerRegex.exec(fileContent)) !== null) {
        topicsConsumed.push(match[1]);
    }
    const producerRegex = /KafkaTemplate.*\.send\(\s*["']([^"']+)["']/g;
    while ((match = producerRegex.exec(fileContent)) !== null) {
        topicsProduced.push(match[1]);
    }
    if (topicsConsumed.length === 0 && topicsProduced.length === 0) {
        return events;
    }
    if (topicsConsumed.length > 0) {
        if (fileContent.includes("RestTemplate") || fileContent.includes("FeignClient") || fileContent.includes("HttpClient")) {
            violations.push("P4 Violation (KAFKA_SYNC): Potential synchronous blocking call detected inside or near @KafkaListener.");
        }
    }
    events.push({
        className,
        topicsConsumed,
        topicsProduced,
        filePath,
        repository,
        violations
    });
    return events;
}
