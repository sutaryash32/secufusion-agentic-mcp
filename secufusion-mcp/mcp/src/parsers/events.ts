export interface EventTopic {
  className: string;
  topicsConsumed: string[];
  topicsProduced: string[];
  filePath: string;
  repository: string;
  violations: string[];
}

export function parseEventTopics(filePath: string, fileContent: string, repository: string): EventTopic[] {
  const events: EventTopic[] = [];

  const classMatch = fileContent.match(/public\s+class\s+(\w+)/);
  if (!classMatch) return events;

  const className = classMatch[1];
  const topicsConsumed: string[] = [];
  const topicsProduced: string[] = [];
  const violations: string[] = [];

  // Accepts either a quoted literal ("my-topic") or a bare/qualified constant
  // reference (TOPIC, KafkaTopicConfig.EVENTS_TOPIC) — real Spring code almost
  // always uses the latter, so requiring quotes here missed nearly every consumer.
  const listenerRegex = /@KafkaListener\s*\(\s*topics\s*=\s*(?:["']([^"']+)["']|([A-Za-z_][\w.]*))/g;
  let match;
  while ((match = listenerRegex.exec(fileContent)) !== null) {
    topicsConsumed.push(match[1] || match[2]);
  }

  // Matches any *KafkaTemplate-suffixed field (kafkaTemplate, deviceDeletedKafkaTemplate, ...)
  // — not just the literal capitalized type name, which never appears at the call site —
  // and the first .send(...) argument whether it's a quoted literal or a constant reference,
  // allowing the call to wrap onto following lines as it does in practice.
  const producerRegex = /([A-Za-z_]*[Kk]afkaTemplate)\s*\.\s*send\s*\(\s*(?:["']([^"']+)["']|([A-Za-z_][\w.]*))/g;
  while ((match = producerRegex.exec(fileContent)) !== null) {
    topicsProduced.push(match[2] || match[3]);
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
