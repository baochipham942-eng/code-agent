import type { ToolDefinition } from '../../../shared/contract';
import type { ToolSearchItem } from '../../../shared/contract/toolSearch';
import { getToolDefinitionWithCloudMeta } from './toolDefinitions';

export interface ToolSearchExecutionContract {
  name: string;
  loadable: boolean;
  executable: boolean;
  canonicalInvocation?: string;
  definitionName?: string;
  reason?: string;
}

export interface ToolSearchExecutionContractOptions {
  resolveDefinition?: (name: string) => ToolDefinition | undefined;
}

export interface ToolSearchExecutionContractFailure {
  name: string;
  issue: string;
  item: ToolSearchItem;
}

function defaultResolveDefinition(name: string): ToolDefinition | undefined {
  return getToolDefinitionWithCloudMeta(name);
}

export function resolveToolSearchExecutionContract(
  item: ToolSearchItem,
  options: ToolSearchExecutionContractOptions = {},
): ToolSearchExecutionContract {
  const loadable = item.loadable === true;
  const canonicalInvocation = item.canonicalInvocation;

  if (!loadable) {
    return {
      name: item.name,
      loadable: false,
      executable: false,
      canonicalInvocation,
      reason: item.notCallableReason || 'search result is not loadable as an executable tool',
    };
  }

  const resolveDefinition = options.resolveDefinition ?? defaultResolveDefinition;
  const invocationName = canonicalInvocation || item.name;
  const definition = resolveDefinition(invocationName) || resolveDefinition(item.name);

  if (!definition) {
    return {
      name: item.name,
      loadable: true,
      executable: false,
      canonicalInvocation: invocationName,
      reason: `loadable search result has no executable ToolDefinition: ${invocationName}`,
    };
  }

  return {
    name: item.name,
    loadable: true,
    executable: true,
    canonicalInvocation: invocationName,
    definitionName: definition.name,
  };
}

export function findToolSearchExecutionContractFailures(
  items: ToolSearchItem[],
  options: ToolSearchExecutionContractOptions = {},
): ToolSearchExecutionContractFailure[] {
  const failures: ToolSearchExecutionContractFailure[] = [];

  for (const item of items) {
    const contract = resolveToolSearchExecutionContract(item, options);
    if (item.loadable === true && !contract.executable) {
      failures.push({
        name: item.name,
        issue: contract.reason || 'loadable search result is not executable',
        item,
      });
      continue;
    }

    if (item.loadable !== true && !item.notCallableReason && !item.canonicalInvocation) {
      failures.push({
        name: item.name,
        issue: 'non-loadable search result must explain how to invoke or why it is search-only',
        item,
      });
    }
  }

  return failures;
}
