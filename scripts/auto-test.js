/**
 * Auto test script - runs inside the Electron app
 * This script is loaded by the main process and sends a test message
 */

const { ipcMain, BrowserWindow } = require('electron');

// Wait for app to be ready, then send test message
setTimeout(async () => {
  console.log('\n=== AUTO TEST: Starting ===\n');

  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    console.error('No window found');
    return;
  }

  // Send a test message through IPC
  console.log('Sending test message to agent...');

  // Simulate the IPC call that the renderer would make
  const testMessage = '列出当前目录的文件';

  // Trigger the agent through the existing IPC handler
  // The handler is 'agent:send-message'
  try {
    // We need to emit the IPC event internally
    ipcMain.emit('agent:send-message', { sender: win.webContents }, testMessage);
    console.log('Test message sent!');
  } catch (error) {
    console.error('Failed to send test message:', error);
  }
}, 3000);

module.exports = {};
