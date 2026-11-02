import { useEffect } from 'react';
import { startConnectorRequiredWatcher } from '../utils/connectorRequiredWatcher';

/** App 级常驻：连接卡等待连接完成，能力中心打开（ChatView 卸载）期间也要继续盯。 */
export function useConnectorRequiredWatcher(): void {
  useEffect(() => startConnectorRequiredWatcher(), []);
}
