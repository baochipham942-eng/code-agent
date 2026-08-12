import type { CanUseToolFn, ToolContext, ToolHandler, ToolModule, ToolResult } from '../../../protocol/tools';
import { getConfigService } from '../../../services/core/configService';
import { ExternalSearchError, getExternalSearchService } from '../../../services/search/searchSourceRegistry';
import { externalSearchSchema as schema } from './externalSearch.schema';

class ExternalSearchHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(args: Record<string, unknown>, _ctx: ToolContext, canUseTool: CanUseToolFn): Promise<ToolResult<string>> {
    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    try {
      const configService = getConfigService();
      const preference = configService.getSettings().search?.externalSource ?? 'auto';
      // 把设置页配的搜索 key 注入共享服务实例（deps 仅首次创建时生效）；
      // 闭包每次现取 configService，key 变更即时生效。
      const service = getExternalSearchService({
        getServiceApiKey: (serviceId) => configService.getServiceApiKey(serviceId),
      });
      const result = await service.search(preference, args.query as string);
      return {
        ok: true,
        output: result.results.map((item, index) => `### ${index + 1}. ${item.title}\n${item.snippet ?? ''}\n${item.url}${item.date ? `\n${item.date}` : ''}`).join('\n\n'),
        meta: result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message, code: error instanceof ExternalSearchError ? error.reason.toUpperCase() : 'NETWORK_ERROR' };
    }
  }
}

export const externalSearchModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler: () => new ExternalSearchHandler(),
};
