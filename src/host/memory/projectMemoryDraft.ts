// ============================================================================
// init-memory 候选 id
//
// 确定性扫描器已删。/init-memory 由 builtin prompt 命令起草，ProposeProjectMemory
// 用这里的 id 写入 candidate。id = initmem_ + hash(resolve(workingDir) + topic)。
// resolve 由调用方做；本函数不 realpath。
// ============================================================================

import type { ProjectMemoryDraftTopic } from '../../shared/contract/memory';
import { contentHash } from './importers/markdown';

export function draftEntryId(projectDir: string, topic: ProjectMemoryDraftTopic): string {
  return `initmem_${contentHash(`${projectDir}\n${topic}`)}`;
}
