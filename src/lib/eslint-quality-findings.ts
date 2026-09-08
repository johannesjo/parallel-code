import { IPC } from '../../electron/ipc/channels';
import type { EslintQualityResult } from '../ipc/types';
import { invoke } from './ipc';
import type { QualityFinding, QualityFindingProvider } from './quality-findings';

export function createEslintQualityFindingProvider(
  getWorktreePath: () => string,
): QualityFindingProvider {
  return {
    async loadFindings({ files }): Promise<QualityFinding[]> {
      const result = await invoke<EslintQualityResult>(IPC.GetEslintQualityFindings, {
        worktreePath: getWorktreePath(),
        filePaths: files
          .filter((file) => file.status !== 'D' && !file.binary)
          .map((file) => file.path),
      });
      if (result.status === 'not-applicable') return [];
      if (result.status === 'unavailable') throw new Error(result.message);
      return result.findings.map((finding) => ({
        ...finding,
        state: 'open' as const,
        freshness: 'pending' as const,
      }));
    },
  };
}
