import {
  createFixtureQualityFindingProvider,
  type QualityFindingProvider,
} from '../lib/quality-findings';

function createDevQualityFindingProvider(): QualityFindingProvider | undefined {
  // Opt in with a changed file and line so the fixture reconciles against the open task diff.
  if (!import.meta.env.DEV || import.meta.env.VITE_QUALITY_FINDING_FIXTURE !== 'true') {
    return undefined;
  }

  const filePath = import.meta.env.VITE_QUALITY_FINDING_FIXTURE_PATH;
  const startLine = Number(import.meta.env.VITE_QUALITY_FINDING_FIXTURE_LINE);
  if (!filePath || !Number.isInteger(startLine) || startLine < 1) return undefined;

  return createFixtureQualityFindingProvider([
    {
      id: `dev-fixture:${filePath}:${startLine}`,
      source: 'fixture',
      ruleId: 'dev-quality-finding',
      category: 'maintainability',
      severity: 'note',
      location: { filePath, startLine },
      explanation: 'Development fixture for verifying the structured quality-finding review loop.',
      state: 'open',
      freshness: 'pending',
    },
  ]);
}

export const devQualityFindingProvider = createDevQualityFindingProvider();
