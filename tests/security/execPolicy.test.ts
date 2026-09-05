import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ExecPolicyStore,
  getExecPolicyStore,
  resetExecPolicyStore,
} from '../../src/host/security/execPolicy';

describe('ExecPolicyStore', () => {
  let tmpDir: string;
  let store: ExecPolicyStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-policy-test-'));
    store = new ExecPolicyStore(tmpDir);
  });

  afterEach(() => {
    resetExecPolicyStore();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('data directory isolation', () => {
    it('stores policy directly in CODE_AGENT_DATA_DIR', async () => {
      const dataDir = path.join(tmpDir, 'slot-a');
      vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);

      const slotStore = getExecPolicyStore();
      slotStore.addRule(['slot-a-probe'], 'allow');
      await slotStore.save();

      expect(fs.existsSync(path.join(dataDir, 'exec-policy.json'))).toBe(true);
      expect(fs.existsSync(path.join(dataDir, '.code-agent', 'exec-policy.json'))).toBe(false);
    });

    it('falls back to the home config directory when CODE_AGENT_DATA_DIR is unset', async () => {
      const homeDir = path.join(tmpDir, 'home');
      vi.stubEnv('CODE_AGENT_DATA_DIR', '');
      vi.stubEnv('CODE_AGENT_HOME', '');
      vi.stubEnv('HOME', homeDir);

      const fallbackStore = getExecPolicyStore();
      fallbackStore.addRule(['home-probe'], 'allow');
      await fallbackStore.save();

      expect(fs.existsSync(path.join(homeDir, '.code-agent', 'exec-policy.json'))).toBe(true);
    });

    it('keeps rules isolated between different data directories', async () => {
      const dataDirA = path.join(tmpDir, 'slot-a');
      const dataDirB = path.join(tmpDir, 'slot-b');
      vi.stubEnv('HOME', path.join(tmpDir, 'home'));

      vi.stubEnv('CODE_AGENT_DATA_DIR', dataDirA);
      const storeA = getExecPolicyStore();
      storeA.addRule(['slot-a-probe'], 'allow');
      await storeA.save();

      resetExecPolicyStore();
      vi.stubEnv('CODE_AGENT_DATA_DIR', dataDirB);
      const storeB = getExecPolicyStore();
      expect(storeB.match('slot-a-probe')).toBeNull();
      storeB.addRule(['slot-b-probe'], 'allow');
      await storeB.save();

      resetExecPolicyStore();
      vi.stubEnv('CODE_AGENT_DATA_DIR', dataDirA);
      const reloadedStoreA = getExecPolicyStore();
      expect(reloadedStoreA.match('slot-a-probe')).toBe('allow');
      expect(reloadedStoreA.match('slot-b-probe')).toBeNull();
    });
  });

  // ========================================================================
  // 基础匹配
  // ========================================================================

  describe('match', () => {
    it('returns null when no rules exist', () => {
      expect(store.match('npm install')).toBeNull();
    });

    it('matches exact prefix', () => {
      store.addRule(['npm', 'install'], 'allow');
      expect(store.match('npm install')).toBe('allow');
      expect(store.match('npm install lodash')).toBe('allow');
    });

    it('does not match different commands', () => {
      store.addRule(['npm', 'install'], 'allow');
      expect(store.match('npm publish')).toBeNull();
      expect(store.match('yarn install')).toBeNull();
    });

    it('longest prefix wins', () => {
      store.addRule(['git'], 'prompt');
      store.addRule(['git', 'status'], 'allow');
      expect(store.match('git status')).toBe('allow');
      expect(store.match('git push')).toBe('prompt');
    });

    it('supports forbidden decision', () => {
      store.addRule(['rm', '-rf'], 'forbidden');
      expect(store.match('rm -rf /')).toBe('forbidden');
    });

    // 2026-09-05 真机：学到 ['find','.'] 后 `find . -delete` 被前缀放行免审批。
    it('a learned prefix that is itself a safe command does not cover the dangerous flags outside it', () => {
      store.addRule(['find', '.'], 'allow');
      expect(store.match('find . -name "*.ts"')).toBe('allow');
      expect(store.match('find . -delete')).toBeNull();
      expect(store.match('find . -exec rm {} \\;')).toBeNull();
    });

    it('a learned prefix that carries the risk itself keeps allowing', () => {
      store.addRule(['git', 'push'], 'allow');
      expect(store.match('git push origin main')).toBe('allow');
      store.addRule(['npm', 'install'], 'allow');
      expect(store.match('npm install lodash')).toBe('allow');
    });

    it('rules loaded from a file without source are treated as learned and still guarded', () => {
      const dir = path.join(tmpDir, '.code-agent');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'exec-policy.json'), JSON.stringify({
        version: 1,
        rules: [{ pattern: ['find', '.'], decision: 'allow', createdAt: 1 }],
      }));
      const loaded = new ExecPolicyStore(tmpDir);
      expect(loaded.match('find . -name x')).toBe('allow');
      expect(loaded.match('find . -delete')).toBeNull();
    });

    it('builtin rules are not subject to the learned-prefix guard', () => {
      store.addRule(['find', '.'], 'allow', 'builtin');
      expect(store.match('find . -delete')).toBe('allow');
    });
  });

  // ========================================================================
  // 学习
  // ========================================================================

  describe('learnFromApproval', () => {
    it('learns prefix from approved command', () => {
      const learned = store.learnFromApproval('npm install lodash');
      expect(learned).toBe(true);
      expect(store.match('npm install')).toBe('allow');
      expect(store.match('npm install express')).toBe('allow');
    });

    it('does not learn banned prefixes', () => {
      expect(store.learnFromApproval('python3 script.py')).toBe(false);
      expect(store.learnFromApproval('bash -c "ls"')).toBe(false);
      expect(store.learnFromApproval('sudo rm -rf /')).toBe(false);
      expect(store.learnFromApproval('node script.js')).toBe(false);
    });

    it('does not learn a prefix that leaves the approved risk outside it', () => {
      expect(store.learnFromApproval('find . -delete')).toBe(false);
      expect(store.learnFromApproval('find /tmp -exec rm {} \\;')).toBe(false);
      expect(store.getRules()).toHaveLength(0);
      // 风险在前缀里的照学
      expect(store.learnFromApproval('git push origin main')).toBe(true);
    });

    it('does not learn duplicate rules', () => {
      store.learnFromApproval('npm install lodash');
      const secondLearn = store.learnFromApproval('npm install express');
      expect(secondLearn).toBe(false); // same prefix ["npm", "install"]
      expect(store.getRules().length).toBe(1);
    });

    it('handles single-word commands', () => {
      const learned = store.learnFromApproval('make');
      expect(learned).toBe(true);
      expect(store.match('make build')).toBe('allow');
    });

    it('learns from compound commands (first part)', () => {
      // 只取前两个 token
      const learned = store.learnFromApproval('tsc --noEmit --pretty');
      expect(learned).toBe(true);
      expect(store.match('tsc --noEmit')).toBe('allow');
    });
  });

  // ========================================================================
  // 持久化
  // ========================================================================

  describe('persistence', () => {
    it('saves and loads rules', async () => {
      store.addRule(['npm', 'install'], 'allow');
      store.addRule(['make', 'build'], 'allow');
      await store.save();

      // 创建新实例，应该从磁盘加载
      const store2 = new ExecPolicyStore(tmpDir);
      expect(store2.match('npm install lodash')).toBe('allow');
      expect(store2.match('make build')).toBe('allow');
    });

    it('creates directory if needed', async () => {
      const deepDir = path.join(tmpDir, 'deep', 'nested');
      const deepStore = new ExecPolicyStore(deepDir);
      deepStore.addRule(['test'], 'allow');
      await deepStore.save();

      const policyFile = path.join(deepDir, '.code-agent', 'exec-policy.json');
      expect(fs.existsSync(policyFile)).toBe(true);
    });

    it('handles corrupt file gracefully', () => {
      const dir = path.join(tmpDir, '.code-agent');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'exec-policy.json'), 'not json!!');

      // Should not throw, just start fresh
      const corruptStore = new ExecPolicyStore(tmpDir);
      expect(corruptStore.getRules().length).toBe(0);
    });
  });

  // ========================================================================
  // 边界场景
  // ========================================================================

  describe('edge cases', () => {
    it('handles empty command', () => {
      expect(store.match('')).toBeNull();
    });

    it('handles command with extra spaces', () => {
      store.addRule(['npm', 'install'], 'allow');
      expect(store.match('  npm   install  lodash  ')).toBe('allow');
    });

    it('handles quoted arguments', () => {
      store.addRule(['grep'], 'allow');
      expect(store.match('grep "hello world" file.txt')).toBe('allow');
    });

    it('learnFromApproval ignores empty commands', () => {
      expect(store.learnFromApproval('')).toBe(false);
      expect(store.learnFromApproval('   ')).toBe(false);
    });
  });
});
