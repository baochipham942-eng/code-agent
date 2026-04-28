// ============================================================================
// ModelIndicator - 显示当前使用的模型缩写
// ============================================================================
// 2026-04-28 audit B3: 缩写映射已迁至 src/shared/constants/models.ts
// 单一真理源 MODEL_ABBREV，UI 通过 getModelAbbrev() 取值。

import React from 'react';
import { getModelAbbrev } from '@shared/constants';
import type { ModelIndicatorProps } from './types';

export function ModelIndicator({ model }: ModelIndicatorProps) {
  const abbrev = getModelAbbrev(model);

  return (
    <span className="text-purple-400 font-medium" title={`Model: ${model}`}>
      {abbrev}
    </span>
  );
}
