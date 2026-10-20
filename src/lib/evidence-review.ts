import {
  EVIDENCE_LIMITS,
  EVIDENCE_MODEL_PROMPT_LIMIT,
  type EvidenceFinding,
  type EvidenceModelSettings,
  type EvidencePackage,
  type EvidenceScan,
} from '../../electron/shared/evidence';
import { readSingleJsonObject } from './tour-json';

/** Above this many changed lines a change counts as risky on its own. */
const RISKY_CHANGED_LINES = 400;
const TAIL_LINES = 40;
const MAX_TEST_SUMMARY = 1500;
const MAX_FINDING_TEXT = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Whether a build should call the model without being asked. */
export function shouldRunModel(
  settings: EvidenceModelSettings,
  pkg: Pick<EvidencePackage, 'trigger' | 'scan' | 'acceptedFlags'>,
): boolean {
  if (pkg.trigger !== 'agent') return false;
  if (settings.when === 'handoff') return true;
  if (settings.when !== 'risky') return false;
  const { scan } = pkg;
  const openFlag = scan.flags.some(
    (flag) => flag.category !== 'info' && !(flag.id in pkg.acceptedFlags),
  );
  const changed = scan.files.reduce((sum, file) => sum + file.added + file.removed, 0);
  return openFlag || scan.sourceWithoutTests.length > 0 || changed > RISKY_CHANGED_LINES;
}

/** Repository text must not be able to close the data block it sits in. */
export function repoContent(text: string): string {
  const safe = text.replace(/<\/?repo-content/gi, (tag) => tag.replace('<', '&lt;'));
  return `<repo-content>\n${safe}\n</repo-content>`;
}

function factsSection(pkg: EvidencePackage): string {
  const tests = pkg.scan.tests.map((t) => `- [${t.kind}, ${t.change}] ${t.file}: ${t.title}`);
  const flags = pkg.scan.flags.map(
    (f) => `- ${f.category}/${f.rule} ${f.file}${f.line ? `:${f.line}` : ''}: ${f.detail}`,
  );
  const checks = pkg.checks.map((run) => {
    const out = run.outputTail.split(/\r?\n/).slice(-TAIL_LINES).join('\n').trim();
    return `### ${run.name} (${run.kind}): ${run.status}\n${out}`;
  });
  return [
    '## Test changes',
    tests.join('\n') || '(none)',
    '## Flags raised by static rules',
    flags.join('\n') || '(none)',
    '## Unchanged tests importing changed code',
    pkg.scan.coveringTests.join('\n') || '(none)',
    '## Check results (output tails)',
    checks.join('\n\n') || '(no checks ran)',
  ].join('\n');
}

const INSTRUCTIONS = `You review a code change for a human who decides whether to merge it.
Return one JSON object: {"testSummary": string, "findings": [{"severity": "blocker"|"concern", "file": string, "line": number, "text": string}]}.
- testSummary: plain prose, at most ${MAX_TEST_SUMMARY} characters. Describe what the unit and end-to-end tests in this change actually exercise, and what behaviour the change adds without a test.
- findings: at most ${EVIDENCE_LIMITS.maxFindings}, only problems a reviewer must act on. Each must cite a changed file and a line in its new version. "blocker" means the change is wrong or unsafe as written; everything else is "concern". Return [] when there is nothing.
Do not restate check results or flags; the reviewer already sees them.`;

/**
 * The review prompt. Everything taken from the repository, including test
 * titles and check output, is wrapped as data. The diff is cut last, so the
 * facts always fit.
 */
export function buildEvidenceReviewPrompt(
  pkg: EvidencePackage,
  diff: string,
  guidance?: string,
): string {
  const head = [INSTRUCTIONS, guidance ? `\nProject guidance:\n${guidance}` : ''].join('\n');
  const facts = repoContent(factsSection(pkg));
  const budget = EVIDENCE_MODEL_PROMPT_LIMIT - head.length - facts.length - 200;
  const cut = diff.length > budget;
  const body = cut ? `${diff.slice(0, Math.max(0, budget))}\n[diff truncated]` : diff;
  return `${head}\n\n${facts}\n\n## Diff\n${repoContent(body)}\n`;
}

function findingId(file: string, line: number, text: string): string {
  let hash = 0x811c9dc5;
  for (const char of `${file}:${line}:${text}`) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${file}:${line}:${hash.toString(36)}`;
}

function parseFinding(value: unknown, paths: Set<string>): EvidenceFinding | undefined {
  if (!isRecord(value)) return undefined;
  const { severity, file, line, text } = value;
  if (severity !== 'blocker' && severity !== 'concern') return undefined;
  // An uncited finding cannot be checked by the reviewer, so it is dropped.
  if (typeof file !== 'string' || !paths.has(file)) return undefined;
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) return undefined;
  if (typeof text !== 'string' || !text.trim()) return undefined;
  const clipped = text.trim().slice(0, MAX_FINDING_TEXT);
  return { id: findingId(file, line, clipped), severity, file, line, text: clipped };
}

/** Parses the model's answer; throws when it is not the requested object. */
export function parseEvidenceReview(
  response: string,
  scan: Pick<EvidenceScan, 'files'>,
): { testSummary?: string; findings: EvidenceFinding[] } {
  const data = readSingleJsonObject(response, 'findings');
  if (!isRecord(data) || !Array.isArray(data.findings))
    throw new Error('The model returned an invalid evidence review. Try again.');
  const paths = new Set(scan.files.map((file) => file.path));
  const findings = data.findings
    .map((item) => parseFinding(item, paths))
    .filter((item): item is EvidenceFinding => Boolean(item))
    .slice(0, EVIDENCE_LIMITS.maxFindings);
  const summary =
    typeof data.testSummary === 'string' ? data.testSummary.trim().slice(0, MAX_TEST_SUMMARY) : '';
  return { ...(summary && { testSummary: summary }), findings };
}
