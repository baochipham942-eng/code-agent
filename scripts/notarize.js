// ============================================================================
// macOS Notarization Script
// 用于 Apple 公证，使应用可以在其他 Mac 上运行
// ============================================================================

const { notarize } = require('@electron/notarize');
const path = require('path');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;

  // 只在 macOS 上执行公证
  if (electronPlatformName !== 'darwin') {
    return;
  }

  // 检查是否配置了 Apple 凭据
  if (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD) {
    console.log('Skipping notarization: Apple credentials not configured');
    console.log('To enable notarization, set APPLE_ID and APPLE_APP_SPECIFIC_PASSWORD');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  console.log(`Notarizing ${appPath}...`);

  try {
    await notarize({
      tool: 'notarytool',
      appPath,
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    });

    console.log('Notarization complete!');
  } catch (error) {
    console.error('Notarization failed:', error);
    // 不抛出错误，允许构建继续（开发阶段）
    // throw error;
  }
};
