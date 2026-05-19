// Schema-only file
import type { ToolSchema } from '../../../protocol/tools';

export const photoArchiveSchema: ToolSchema = {
  name: 'photo_archive',
  description: `相册归档工具 — 调用 macOS Vision Framework + Photos.app 完整链路，
做人脸聚类 + 主题分类 + 入库 memories 表 (type='photo_archive')。

**适用场景**：
- 整理 macOS Photos.app 里的相册（按相册名或照片 uuid 列表）
- 自动检测人脸 + 聚类同一人
- 自动给照片打主题标签（ImageNet 1000 类）
- 把归档结果入库，后续可用 memory_search 按人物/主题搜照片

**底层依赖**（用户不需要配 API key）：
- vision-tagger Swift binary (走 macOS 系统 Vision Framework)
- photos connector (访问 Photos.app via AppleScript)

**调用流程**（service 内部）：
1. photos connector → export_photos → 导出到临时目录
2. 逐张调 vision-tagger → 人脸 + 主题
3. cosine similarity 阈值聚类
4. 入库 memories (type='photo_archive')
5. 清理临时目录

**前置条件**：
- 仅 macOS（依赖 Vision Framework + Photos.app）
- 首次需用户授权 Photos.app 自动化访问权限
- photos connector 已启用

参数：
- album: 相册名（与 uuids 二选一）
- uuids: 照片 uuid 数组（与 album 二选一）
- mode: 'face' | 'classify' | 'all'（默认 'all'）
- faceSimilarityThreshold: 人脸聚类阈值（默认 0.6，0.5-0.8 可调）
- cleanupExport: 是否处理后删除临时导出目录（默认 true）

返回：
- processed: 成功处理的照片数
- failed: 失败数
- faceCount: 总检测到人脸数
- clusters: 人脸聚类 [{ clusterId: 'person-1', size, samplePaths[] }]
- topThemes: top 20 主题 [{ identifier, count }]
- memoryIds: 入库的 memory id 列表`,
  inputSchema: {
    type: 'object',
    properties: {
      album: {
        type: 'string',
        description: 'Photos.app 中的相册名',
      },
      uuids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Photos.app 中的照片 uuid 数组',
      },
      mode: {
        type: 'string',
        enum: ['face', 'classify', 'all'],
        description: '归档模式，默认 all',
      },
      faceSimilarityThreshold: {
        type: 'number',
        description: '人脸聚类 cosine similarity 阈值，默认 0.6',
      },
      cleanupExport: {
        type: 'boolean',
        description: '是否清理临时导出目录，默认 true',
      },
    },
  },
  category: 'vision',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
