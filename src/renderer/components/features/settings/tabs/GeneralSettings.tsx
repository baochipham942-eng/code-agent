// ============================================================================
// GeneralSettings - General Application Settings Tab
// Including Mode Selection (Developer / Cowork)
// ============================================================================

import React from 'react';
import { Code, Users, CheckCircle } from 'lucide-react';
import { useModeStore, type AppMode } from '../../../../stores/modeStore';
import { useI18n } from '../../../../hooks/useI18n';

// ============================================================================
// Types
// ============================================================================

interface ModeOption {
  id: AppMode;
  icon: React.ReactNode;
  title: string;
  description: string;
  features: string[];
}

// ============================================================================
// Component
// ============================================================================

export const GeneralSettings: React.FC = () => {
  const { t } = useI18n();
  const { mode, setMode } = useModeStore();

  const modeOptions: ModeOption[] = [
    {
      id: 'developer',
      icon: <Code className="w-5 h-5" />,
      title: t.settings?.general?.developerMode || '开发者模式',
      description: t.settings?.general?.developerModeDesc || '显示完整的工具调用详情和参数',
      features: [
        '完整的工具调用参数',
        '详细的执行日志',
        '思维过程展示',
        '适合调试和开发',
      ],
    },
    {
      id: 'cowork',
      icon: <Users className="w-5 h-5" />,
      title: t.settings?.general?.coworkMode || 'Cowork 模式',
      description: t.settings?.general?.coworkModeDesc || '简化展示，适合与其他 AI 协作',
      features: [
        '简化消息展示',
        '折叠思维过程',
        '工作空间分组',
        '适合多 Agent 协作',
      ],
    },
  ];

  return (
    <div className="space-y-6">
      {/* Mode Selection */}
      <div>
        <h3 className="text-sm font-medium text-zinc-100 mb-2">
          {t.settings?.general?.modeTitle || '应用模式'}
        </h3>
        <p className="text-xs text-zinc-500 mb-4">
          {t.settings?.general?.modeDescription || '选择适合你工作方式的模式'}
        </p>

        <div className="grid grid-cols-1 gap-3">
          {modeOptions.map((option) => {
            const isActive = mode === option.id;
            return (
              <button
                key={option.id}
                onClick={() => setMode(option.id)}
                className={`relative p-4 rounded-xl border text-left transition-all duration-200 ${
                  isActive
                    ? 'border-primary-500/50 bg-primary-500/10 shadow-lg shadow-primary-500/10'
                    : 'border-zinc-700/50 bg-zinc-800/30 hover:border-zinc-600 hover:bg-zinc-800/50'
                }`}
              >
                <div className="flex items-start gap-4">
                  {/* Icon */}
                  <div
                    className={`p-2.5 rounded-lg ${
                      isActive
                        ? 'bg-primary-500/20 text-primary-400'
                        : 'bg-zinc-700/50 text-zinc-400'
                    }`}
                  >
                    {option.icon}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h4
                        className={`text-sm font-medium ${
                          isActive ? 'text-zinc-100' : 'text-zinc-300'
                        }`}
                      >
                        {option.title}
                      </h4>
                      {isActive && (
                        <CheckCircle className="w-4 h-4 text-primary-400" />
                      )}
                    </div>
                    <p className="text-xs text-zinc-500 mt-1">
                      {option.description}
                    </p>

                    {/* Feature list */}
                    <ul className="mt-3 space-y-1">
                      {option.features.map((feature, index) => (
                        <li
                          key={index}
                          className={`text-xs flex items-center gap-2 ${
                            isActive ? 'text-zinc-400' : 'text-zinc-500'
                          }`}
                        >
                          <span
                            className={`w-1 h-1 rounded-full ${
                              isActive ? 'bg-primary-400' : 'bg-zinc-600'
                            }`}
                          />
                          {feature}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                {/* Active indicator */}
                {isActive && (
                  <div className="absolute top-0 right-0 w-0 h-0 border-t-[24px] border-r-[24px] border-t-primary-500 border-r-transparent rounded-tr-xl" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Mode-specific info */}
      {mode === 'cowork' && (
        <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20">
          <div className="flex items-start gap-3">
            <Users className="w-4 h-4 text-amber-400 mt-0.5" />
            <div>
              <h4 className="text-sm font-medium text-amber-300">Cowork 模式已启用</h4>
              <p className="text-xs text-amber-400/70 mt-1">
                消息展示已简化，适合与 Claude Code、Gemini CLI 等其他 AI 工具协作。
                工具调用详情将被折叠，只显示执行摘要。
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
