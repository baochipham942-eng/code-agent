import { Key, Plus } from 'lucide-react';
import { Button, Input, Select } from '../../../primitives';
import type { ModelProviderProtocol } from '@shared/contract';
import { isWebMode } from '../../../../utils/platform';
import { ProviderDetailCard } from './ProviderDetailSections';
import { useI18n } from '../../../../hooks/useI18n';

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
  const { t } = useI18n();
  const addProviderText = t.settings.model.addProvider;
  const connectionText = t.settings.model.connection;

  return (
    <ProviderDetailCard step="+" title={addProviderText.title}>
      <div className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <label className="mb-2 block text-sm font-medium text-zinc-200">{addProviderText.displayName}</label>
            <Input
              value={name}
              onChange={(event) => onNameChange(event.target.value)}
              placeholder="windhub.cc"
            />
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-zinc-200">{connectionText.protocolLabel}</label>
            <Select
              value={protocol}
              onChange={(event) => onProtocolChange(event.target.value as ModelProviderProtocol)}
            >
              <option value="openai">{connectionText.protocolOpenai}</option>
              <option value="claude">{connectionText.protocolClaude}</option>
            </Select>
          </div>
        </div>
        <div>
          <label className="mb-2 block text-sm font-medium text-zinc-200">{connectionText.baseUrlLabel}</label>
          <Input
            value={baseUrl}
            onChange={(event) => onBaseUrlChange(event.target.value)}
            placeholder="https://example.com/v1"
          />
          <p className="mt-2 text-xs text-zinc-500">{addProviderText.baseUrlHint}</p>
        </div>
        <div>
          <label className="mb-2 block text-sm font-medium text-zinc-200">{addProviderText.apiKeyLabel}</label>
          <Input
            type="password"
            value={apiKey}
            onChange={(event) => onApiKeyChange(event.target.value)}
            placeholder="sk-..."
            leftIcon={<Key className="h-4 w-4" />}
          />
        </div>
        <p className="text-xs text-zinc-500">{addProviderText.afterAddHint}</p>
        <Button
          onClick={onAddProvider}
          disabled={isWebMode() || !name.trim() || !baseUrl.trim()}
          leftIcon={<Plus className="h-4 w-4" />}
          size="lg"
          className="w-full"
        >
          {addProviderText.submit}
        </Button>
      </div>
    </ProviderDetailCard>
  );
}
