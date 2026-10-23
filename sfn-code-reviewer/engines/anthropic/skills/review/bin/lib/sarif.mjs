// review-result -> SARIF 2.1.0. Pure; unit-tested.

export function toSarif(result) {
  const level = { blocker: 'error', major: 'error', minor: 'warning', nit: 'note' };
  const rules = new Map();
  for (const f of result.findings) {
    if (!rules.has(f.ruleId)) {
      rules.set(f.ruleId, {
        id: f.ruleId,
        name: f.ruleId,
        shortDescription: { text: f.ruleId === 'GEN' ? 'General finding' : `sfn rule ${f.ruleId}` },
        properties: { category: f.category },
      });
    }
  }
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'sfn-code-reviewer',
            informationUri: 'https://dev.azure.com/secufusion/SFCloud-MSSP/_git/sfn-code-reviewer',
            rules: [...rules.values()],
          },
        },
        results: result.findings.map((f) => ({
          ruleId: f.ruleId,
          level: level[f.severity],
          message: { text: `${f.title}\n\n${f.problem}\n\nFails when: ${f.failureScenario}\n\nFix: ${f.suggestion}` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.repo && f.repo !== result.scope?.repoKey ? `../${f.repo}/${f.file}` : f.file },
                region: { startLine: f.line, ...(f.endLine ? { endLine: f.endLine } : {}) },
              },
            },
          ],
          partialFingerprints: { sfnFindingId: f.id },
          properties: { severity: f.severity, confidence: f.confidence, anchor: f.anchor },
        })),
      },
    ],
  };
}
