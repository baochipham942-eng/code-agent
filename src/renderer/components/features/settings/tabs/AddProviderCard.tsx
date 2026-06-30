import { Key, Plus } from 'lucide-react';
import { Button, Input, Select } from '../../../primitives';
import type { ModelProviderProtocol } from '@shared/contract';
import { isWebMode } from '../../../../utils/platform';
import { ProviderDetailCard } from './ProviderDetailSections';

export interface AddProviderCardProps {
  name: string;
  protocol: ModelProviderProtocol;
  baseUrl: string;
  apiKey: string;
  onNameChange: (value: string) => void;
  onProtocolChange: (value: ModelProviderProtocol) => void;
  onBaseUrlChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onAddProvider: () => void;
}

export function AddProviderCard({
  name,
  protocol,
  baseUrl,
  apiKey,
  onNameChange,
  onProtocolChange,
  onBaseUrlChange,
  onApiKeyChange,
  onAddProvider,
}: AddProviderCardProps) {
  return (
    <ProviderDetailCard step="+" title="新增">
      <div className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <label className="mb-2 block text-sm font-medium text-zinc-200">显示名称</label>
            <Input
              value={name}
              onChange={(event) => onNameChange(event.target.value)}
              placeholder="windhub.cc"
            />
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-zinc-200">协议</label>
            <Select
              value={protocol}
              onChange={(event) => onProtocolChange(event.target.value as ModelProviderProtocol)}
            >
              <option value="openai">OpenAI 兼容</option>
              <option value="claude">Claude 协议</option>
            </Select>
          </div>
        </div>
        <div>
          <label className="mb-2 block text-sm font-medium text-zinc-200">接口地址（Base URL）</label>
          <Input
            value={baseUrl}
            onChange={(event) => onBaseUrlChange(event.target.value)}
            placeholder="https://example.com/v1"
          />
          <p className="mt-2 text-xs text-zinc-500">填到 /v1 为止，不要带 /chat/completions。</p>
        </div>
        <div>
          <label className="mb-2 block text-sm font-medium text-zinc-200">API Key</label>
          <Input
            type="password"
            value={apiKey}
            onChange={(event) => onApiKeyChange(event.target.value)}
            placeholder="sk-..."
            leftIcon={<Key className="h-4 w-4" />}
          />
        </div>
        <p className="text-xs text-zinc-500">添加后点击「发现模型」拉取该 Provider 的可用模型列表。</p>
        <Button
          onClick={onAddProvider}
          disabled={isWebMode() || !name.trim() || !baseUrl.trim()}
          leftIcon={<Plus className="h-4 w-4" />}
          size="lg"
          className="w-full"
        >
          添加 Provider
        </Button>
      </div>
    </ProviderDetailCard>
  );
}
