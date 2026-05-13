// ============================================================================
// Doctor Check - Environment / Database / Config / Disk
// 从原 src/main/ipc/doctor.ipc.ts 抽出，逻辑保持一致
// ============================================================================

import { existsSync } from 'fs';
import { stat } from 'fs/promises';
import { join } from 'path';
import { getUserConfigDir } from '../../config/configPaths';
import type { DoctorItem } from '../types';

export function checkNodeVersion(): DoctorItem {
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0], 10);
  const isPass = major >= 18;
  return {
    category: 'environment',
    name: 'Node.js version',
    status: isPass ? 'pass' : 'fail',
    message: `Node.js ${version}`,
    details: isPass ? undefined : 'Requires Node.js >= 18',
    suggestion: isPass ? undefined : '请升级 Node.js 到 18 或以上版本',
  };
}

export function checkConfigDir(): DoctorItem {
  const configDir = getUserConfigDir();
  const exists = existsSync(configDir);
  return {
    category: 'config',
    name: 'Config directory',
    status: exists ? 'pass' : 'warn',
    message: exists ? configDir : 'Config directory not found',
    details: exists ? undefined : `Expected at ${configDir}`,
    suggestion: exists ? undefined : '应用首次启动会自动创建配置目录，可忽略此警告',
  };
}

export async function checkDatabase(): Promise<DoctorItem> {
  const dbPath = join(getUserConfigDir(), 'code-agent.db');
  if (!existsSync(dbPath)) {
    return {
      category: 'database',
      name: 'SQLite database',
      status: 'warn',
      message: 'Database not found',
      suggestion: '应用首次运行时会自动创建数据库，可忽略',
    };
  }
  try {
    const stats = await stat(dbPath);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
    return {
      category: 'database',
      name: 'SQLite database',
      status: 'pass',
      message: `${sizeMB} MB`,
      details: dbPath,
    };
  } catch (err) {
    return {
      category: 'database',
      name: 'SQLite database',
      status: 'fail',
      message: 'Cannot read database',
      details: err instanceof Error ? err.message : String(err),
      suggestion: '检查数据库文件权限，或删除后让应用重建',
    };
  }
}

export async function checkDiskUsage(): Promise<DoctorItem> {
  const configDir = getUserConfigDir();
  if (!existsSync(configDir)) {
    return {
      category: 'disk',
      name: 'Disk usage',
      status: 'pass',
      message: 'No data directory',
    };
  }
  try {
    await stat(configDir);
    return {
      category: 'disk',
      name: 'Config directory size',
      status: 'pass',
      message: 'Checked',
      details: configDir,
    };
  } catch {
    return {
      category: 'disk',
      name: 'Disk usage',
      status: 'warn',
      message: 'Cannot check disk usage',
      suggestion: '检查配置目录的访问权限',
    };
  }
}
