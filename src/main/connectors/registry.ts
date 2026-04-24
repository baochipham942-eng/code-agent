// ============================================================================
// Connector Registry - Unified access to office connectors
// ----------------------------------------------------------------------------
// 连接器采用"按需激活"模型：构造函数只准备 factory，不自动注册。
// ConfigService 初始化后通过 configure() 按用户设置批量同步。
// ============================================================================

import type { Connector } from './base';
import { calendarConnector, resetCalendarConnectorReadiness } from './native/calendar';
import { mailConnector, resetMailConnectorReadiness } from './native/mail';
import { remindersConnector, resetRemindersConnectorReadiness } from './native/reminders';
import { NATIVE_CONNECTOR_IDS, type NativeConnectorId } from '../../shared/constants';

type ConnectorFactory = () => Connector;

const NATIVE_FACTORIES: Record<NativeConnectorId, ConnectorFactory> = {
  calendar: () => calendarConnector,
  mail: () => mailConnector,
  reminders: () => remindersConnector,
};

const NATIVE_READINESS_RESETTERS: Record<NativeConnectorId, () => void> = {
  calendar: resetCalendarConnectorReadiness,
  mail: resetMailConnectorReadiness,
  reminders: resetRemindersConnectorReadiness,
};

function resetNativeConnectorReadiness(id: string): void {
  if (id in NATIVE_READINESS_RESETTERS) {
    NATIVE_READINESS_RESETTERS[id as NativeConnectorId]();
  }
}

export class ConnectorRegistry {
  private connectors = new Map<string, Connector>();

  register(connector: Connector): void {
    this.connectors.set(connector.id, connector);
  }

  unregister(id: string): boolean {
    resetNativeConnectorReadiness(id);
    return this.connectors.delete(id);
  }

  get(id: string): Connector | undefined {
    return this.connectors.get(id);
  }

  list(): Connector[] {
    return Array.from(this.connectors.values());
  }

  /** 返回 registry 感知到的所有可启用的原生连接器 id（不代表已激活）*/
  listAvailableNativeIds(): readonly NativeConnectorId[] {
    return NATIVE_CONNECTOR_IDS;
  }

  /**
   * 按 enabledIds 同步内部连接器集合。
   * - 未出现在 enabledIds 的已注册连接器 → 反注册
   * - 出现在 enabledIds 且已知的 → 确保注册（幂等）
   * - 未知 id → 跳过
   */
  configure(enabledIds: readonly string[]): void {
    const nextIds = new Set<string>();
    for (const id of enabledIds) {
      if (id in NATIVE_FACTORIES) {
        nextIds.add(id);
      }
    }

    for (const id of Array.from(this.connectors.keys())) {
      if (!nextIds.has(id)) {
        resetNativeConnectorReadiness(id);
        this.connectors.delete(id);
      }
    }

    for (const id of nextIds) {
      if (!this.connectors.has(id)) {
        const factory = NATIVE_FACTORIES[id as NativeConnectorId];
        this.connectors.set(id, factory());
      }
    }
  }
}

let instance: ConnectorRegistry | null = null;

export function getConnectorRegistry(): ConnectorRegistry {
  if (!instance) {
    instance = new ConnectorRegistry();
  }
  return instance;
}
