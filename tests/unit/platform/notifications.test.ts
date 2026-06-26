import { describe, expect, it } from 'vitest';
import { Notification } from '../../../src/host/platform/notifications';

describe('platform Notification', () => {
  it('retains click listeners instead of dropping them', () => {
    const notification = new Notification({ title: 'Done', body: 'Task completed' });
    let clicks = 0;

    notification.on('click', () => {
      clicks += 1;
    });

    expect(notification.emit('click')).toBe(true);
    expect(clicks).toBe(1);
  });

  it('supports once listeners for notification callbacks', () => {
    const notification = new Notification();
    let clicks = 0;

    notification.once('click', () => {
      clicks += 1;
    });

    notification.emit('click');
    notification.emit('click');

    expect(clicks).toBe(1);
  });
});
