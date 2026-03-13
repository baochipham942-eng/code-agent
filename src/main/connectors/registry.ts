// ============================================================================
// Connector Registry - Unified access to office connectors
// ============================================================================

import type { Connector } from './base';
import { calendarConnector } from './native/calendar';
import { mailConnector } from './native/mail';
import { remindersConnector } from './native/reminders';

export class ConnectorRegistry {
  private connectors = new Map<string, Connector>();

  constructor() {
    this.register(calendarConnector);
    this.register(mailConnector);
    this.register(remindersConnector);
  }

  register(connector: Connector): void {
    this.connectors.set(connector.id, connector);
  }

  get(id: string): Connector | undefined {
    return this.connectors.get(id);
  }

  list(): Connector[] {
    return Array.from(this.connectors.values());
  }
}

let instance: ConnectorRegistry | null = null;

export function getConnectorRegistry(): ConnectorRegistry {
  if (!instance) {
    instance = new ConnectorRegistry();
  }
  return instance;
}
