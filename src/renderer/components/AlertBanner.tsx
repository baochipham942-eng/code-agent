// ============================================================================
// AlertBanner - 告警横幅组件
// 显示连续错误告警、系统状态等通知
// ============================================================================

// ============================================================================
// Types
// ============================================================================

export type AlertLevel = 'info' | 'warning' | 'error' | 'critical';

export interface Alert {
  id: string;
  level: AlertLevel;
  title: string;
  message: string;
  timestamp: number;
  dismissible?: boolean;
  action?: {
    label: string;
    onClick: () => void;
  };
  details?: string;
}
