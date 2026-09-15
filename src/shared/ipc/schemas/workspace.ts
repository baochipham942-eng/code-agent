// ============================================================================
// Workspace Domain Schemas - workspace 域 action 集合真源（RQ-183 续作·WORKSPACE 刀）
// ============================================================================
//
// 最小表形态（同 session/memory/desktop/tag/cron/loop 域）：action 用 z.enum 钉死合法字面量，payload 保持
// z.unknown。集合与 shellCapabilities 的 workspace 域、handler 表（src/host/ipc/workspace.ipc.ts）三面由
// tests/scripts/domainRouteParity.test.ts 做结构枚举对账——新 action 三处一起改。
import { z } from 'zod';
import { IPC_DOMAINS } from '../domains';
import { channelSchema } from './core';

const WorkspaceDomainRequestSchema = z.object({
  action: z.enum([
    'closeLinkInRail',
    'controlUserBrowserHistory',
    'createFile',
    'createFolder',
    'createShareLink',
    'deleteBrand',
    'deleteCustomImageModel',
    'deleteCustomVideoModel',
    'dispatchUserBrowserInput',
    'downloadFile',
    'editDesignImage',
    'editImageByAnnotation',
    'expandDesignImage',
    'exportBundle',
    'exportCanvasPptx',
    'exportImagePdf',
    'exportPrototypePdf',
    'extractBrandFromImage',
    'findFile',
    'generateDesignImage',
    'generateDesignMusic',
    'generateDesignVideo',
    'generateSlidesDeck',
    'generateSlidesOutline',
    'generateSlidesPreview',
    'getConfigScope',
    'getCurrent',
    'getDesignMdSummary',
    'getDesignSettings',
    'getFileMetadata',
    'getPublishInfo',
    'getShareLink',
    'importDesignImage',
    'importDesignImageFromPath',
    'inspectArchive',
    'inspectPresentation',
    'listBrands',
    'listCustomImageModels',
    'listCustomVideoModels',
    'listFiles',
    'listRecent',
    'listVisualImageModels',
    'listVisualMusicModels',
    'listVisualVideoModels',
    'openExternal',
    'openLinkInRail',
    'openPath',
    'previewPresentation',
    'publishVersion',
    'pushShareLink',
    'readBinary',
    'readFile',
    'removeRecent',
    'removeWatermarkDesignImage',
    'resolveDesignDir',
    'revokeShareLink',
    'saveBinaryToDownloads',
    'saveBrand',
    'saveCustomImageModel',
    'saveCustomVideoModel',
    'saveTextToDownloads',
    'selectDirectory',
    'setActiveBrand',
    'setCurrent',
    'setUserBrowserViewport',
    'showItemInFolder',
    'updateDesignSettings',
    'updateShareLinkTtl',
    'writeFile',
  ]),
  payload: z.unknown().optional(),
  requestId: z.string().optional(),
});

export type WorkspaceDomainRequest = z.infer<typeof WorkspaceDomainRequestSchema>;

export const WorkspaceSchemas = {
  REQUEST: channelSchema({ channel: IPC_DOMAINS.WORKSPACE, payload: WorkspaceDomainRequestSchema }),
  /** action 字面量集合：shellCapabilities 派生用（shared 层零 host 依赖） */
  ACTIONS: WorkspaceDomainRequestSchema.shape.action.options,
} as const;
