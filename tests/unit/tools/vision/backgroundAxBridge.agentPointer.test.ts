import { describe, expect, it } from 'vitest';

import { BackgroundAxBridge, type BackgroundAxElement } from '../../../../src/main/services/desktop/backgroundAxBridge';

describe('BackgroundAxBridge Agent Pointer metadata', () => {
  it('carries the located AX frame into pointer metadata', () => {
    const bridge = new BackgroundAxBridge();
    const elements: BackgroundAxElement[] = [{
      index: 1,
      role: 'AXButton',
      name: 'Send',
      axPath: '1.2.3',
      frame: { x: 20, y: 30, width: 80, height: 20, coordSpace: 'screen' },
    }];

    const result = bridge.locateElementFromList({
      action: 'locate_role',
      targetApp: 'Notes',
      role: 'button',
      name: 'Send',
    }, {
      success: true,
      output: 'ok',
      metadata: { elements },
    });

    expect(result.success).toBe(true);
    expect(result.metadata).toMatchObject({
      targetAxPath: '1.2.3',
      targetAxFrame: { x: 20, y: 30, width: 80, height: 20, coordSpace: 'screen' },
      pointerTarget: {
        label: 'Send',
        boundingBox: { x: 20, y: 30, width: 80, height: 20, coordSpace: 'screen' },
        coordSpace: 'screen',
      },
    });
  });
});
