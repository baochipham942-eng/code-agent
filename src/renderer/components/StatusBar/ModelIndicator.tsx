// ============================================================================
// ModelIndicator - 显示当前使用的模型缩写
// ============================================================================

import React from 'react';
import type { ModelIndicatorProps } from './types';

// 模型名称缩写映射
const MODEL_ABBREV: Record<string, string> = {
  'deepseek-chat': 'deepseek',
  'deepseek-reasoner': 'reasoner',
  'gpt-4o': 'gpt-4o',
  'gpt-4o-mini': '4o-mini',
  'gpt-4-turbo': 'gpt-4t',
  'gpt-3.5-turbo': 'gpt-3.5',
  'claude-3-5-sonnet': 'sonnet',
  'claude-3-5-sonnet-20241022': 'sonnet',
  'claude-3-opus': 'opus',
  'claude-3-opus-20240229': 'opus',
  'claude-3-haiku': 'haiku',
  'claude-3-haiku-20240307': 'haiku',
  'claude-sonnet-4-20250514': 'sonnet-4',
  'claude-opus-4-20250514': 'opus-4',
};

export function ModelIndicator({ model }: ModelIndicatorProps) {
  // 尝试从映射中获取缩写，否则截取前 10 个字符
  const abbrev = MODEL_ABBREV[model] || model.slice(0, 10);

  return (
    <span className="text-purple-400 font-medium" title={`Model: ${model}`}>
      {abbrev}
    </span>
  );
}
