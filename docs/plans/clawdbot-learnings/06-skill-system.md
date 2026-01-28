# Skill 技能系统

## 问题描述

当前 Code Agent 的 Skill 系统是内置的，用户无法自定义。Clawdbot 支持：

1. **用户可定义 Skill**：通过 Markdown + YAML frontmatter 定义
2. **Skill 依赖声明**：声明所需的工具、二进制文件、权限
3. **Skill 发现与加载**：自动扫描和加载 skill 目录

## Clawdbot 实现分析

### 目录结构

```
skills/
├── weather/
│   └── SKILL.md           # Skill 定义
├── coding-agent/
│   └── SKILL.md
├── github/
│   └── SKILL.md
├── 1password/
│   ├── SKILL.md
│   └── references/        # 参考文档
│       ├── cli-examples.md
│       └── get-started.md
└── ...
```

### SKILL.md 格式

```yaml
---
name: weather
description: Get current weather and forecasts (no API key required).
homepage: https://wttr.in/:help
metadata: {"moltbot":{"emoji":"🌤️","requires":{"bins":["curl"]}}}
---

# Weather

Two free services, no API keys needed.

## wttr.in (primary)

Quick one-liner:
```bash
curl -s "wttr.in/London?format=3"
```

...
```

### 元数据字段

```typescript
interface SkillMetadata {
  moltbot: {
    emoji?: string;           // 显示图标
    requires?: {
      bins?: string[];        // 需要的命令行工具
      anyBins?: string[];     // 需要其中任一命令行工具
      permissions?: string[]; // 需要的权限
      envVars?: string[];     // 需要的环境变量
    };
    tags?: string[];          // 分类标签
    priority?: number;        // 优先级
  };
}
```

### 加载逻辑

Clawdbot 在启动时扫描 `skills/` 目录，解析每个 `SKILL.md`：
1. 解析 YAML frontmatter
2. 检查依赖是否满足
3. 将 Skill 内容注入到 Agent 的知识库

## Code Agent 现状

当前 Skill 实现在 `src/main/tools/gen4/skill.ts`：
- 内置几个固定 Skill（file-organizer, commit, code-review）
- 用户无法自定义
- 没有依赖检查机制

## 借鉴方案

### Step 1: Skill 类型定义

```typescript
// src/shared/types/skill.ts

export interface SkillRequirements {
  bins?: string[];           // 必需的命令行工具
  anyBins?: string[];        // 任一即可
  permissions?: string[];    // 需要的权限
  envVars?: string[];        // 需要的环境变量
  tools?: string[];          // 需要的 Agent 工具
}

export interface SkillMetadata {
  emoji?: string;
  requires?: SkillRequirements;
  tags?: string[];
  priority?: number;
  author?: string;
  version?: string;
  homepage?: string;
}

export interface Skill {
  id: string;                // 唯一标识（目录名）
  name: string;              // 显示名称
  description: string;       // 简短描述
  content: string;           // Markdown 内容
  metadata: SkillMetadata;
  source: 'builtin' | 'user' | 'community';
  path?: string;             // 文件路径（用户 Skill）
  enabled: boolean;
  available: boolean;        // 依赖是否满足
  unavailableReason?: string;
}

export interface SkillReference {
  name: string;
  path: string;
  content: string;
}

export interface SkillWithReferences extends Skill {
  references: SkillReference[];
}
```

### Step 2: Skill 加载器

```typescript
// src/main/skills/skillLoader.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import matter from 'gray-matter';
import { execFileNoThrow } from '../utils/execFileNoThrow';
import { Skill, SkillMetadata, SkillWithReferences } from '@shared/types/skill';

const SKILL_FILE = 'SKILL.md';
const REFERENCES_DIR = 'references';

export class SkillLoader {
  private skillsDir: string;

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
  }

  async loadAll(): Promise<Skill[]> {
    const skills: Skill[] = [];

    try {
      const entries = await fs.readdir(this.skillsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillPath = path.join(this.skillsDir, entry.name, SKILL_FILE);
        try {
          const skill = await this.loadSkill(entry.name, skillPath);
          if (skill) {
            skills.push(skill);
          }
        } catch (err) {
          console.warn(`[SkillLoader] Failed to load skill ${entry.name}:`, err);
        }
      }
    } catch (err) {
      console.error('[SkillLoader] Failed to read skills directory:', err);
    }

    return skills;
  }

  async loadSkill(id: string, filePath: string): Promise<Skill | null> {
    const content = await fs.readFile(filePath, 'utf-8');
    const { data: frontmatter, content: body } = matter(content);

    const metadata = this.parseMetadata(frontmatter);

    const skill: Skill = {
      id,
      name: frontmatter.name || id,
      description: frontmatter.description || '',
      content: body.trim(),
      metadata,
      source: 'user',
      path: filePath,
      enabled: true,
      available: true,
    };

    // 检查依赖
    const availability = await this.checkAvailability(skill);
    skill.available = availability.available;
    skill.unavailableReason = availability.reason;

    return skill;
  }

  async loadWithReferences(id: string): Promise<SkillWithReferences | null> {
    const skillDir = path.join(this.skillsDir, id);
    const skillPath = path.join(skillDir, SKILL_FILE);

    const skill = await this.loadSkill(id, skillPath);
    if (!skill) return null;

    const references: SkillReference[] = [];
    const refsDir = path.join(skillDir, REFERENCES_DIR);

    try {
      const refFiles = await fs.readdir(refsDir);
      for (const refFile of refFiles) {
        if (!refFile.endsWith('.md')) continue;
        const refPath = path.join(refsDir, refFile);
        const refContent = await fs.readFile(refPath, 'utf-8');
        references.push({
          name: refFile.replace('.md', ''),
          path: refPath,
          content: refContent,
        });
      }
    } catch {
      // references 目录不存在，忽略
    }

    return { ...skill, references };
  }

  private parseMetadata(frontmatter: Record<string, unknown>): SkillMetadata {
    const raw = frontmatter.metadata;
    if (!raw) return {};

    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return parsed.moltbot || parsed;
    } catch {
      return {};
    }
  }

  private async checkAvailability(skill: Skill): Promise<{
    available: boolean;
    reason?: string;
  }> {
    const requires = skill.metadata.requires;
    if (!requires) return { available: true };

    // 检查必需的二进制文件
    if (requires.bins?.length) {
      for (const bin of requires.bins) {
        if (!await this.commandExists(bin)) {
          return {
            available: false,
            reason: `需要命令行工具: ${bin}`,
          };
        }
      }
    }

    // 检查任一二进制文件
    if (requires.anyBins?.length) {
      const hasAny = await Promise.all(
        requires.anyBins.map(bin => this.commandExists(bin))
      );
      if (!hasAny.some(Boolean)) {
        return {
          available: false,
          reason: `需要以下工具之一: ${requires.anyBins.join(', ')}`,
        };
      }
    }

    // 检查环境变量
    if (requires.envVars?.length) {
      for (const envVar of requires.envVars) {
        if (!process.env[envVar]) {
          return {
            available: false,
            reason: `需要环境变量: ${envVar}`,
          };
        }
      }
    }

    return { available: true };
  }

  private async commandExists(command: string): Promise<boolean> {
    try {
      // 使用安全的 execFileNoThrow 替代 exec
      const result = await execFileNoThrow('which', [command]);
      return result.status === 0;
    } catch {
      return false;
    }
  }
}
```

### Step 3: Skill 管理服务

```typescript
// src/main/skills/skillService.ts
import { Skill, SkillWithReferences } from '@shared/types/skill';
import { SkillLoader } from './skillLoader';
import { builtinSkills } from './builtinSkills';

export class SkillService {
  private loader: SkillLoader;
  private skills = new Map<string, Skill>();
  private userSkillsDir: string;

  constructor(userSkillsDir: string) {
    this.userSkillsDir = userSkillsDir;
    this.loader = new SkillLoader(userSkillsDir);
  }

  async initialize(): Promise<void> {
    // 1. 加载内置 Skills
    for (const skill of builtinSkills) {
      this.skills.set(skill.id, { ...skill, source: 'builtin' });
    }

    // 2. 加载用户 Skills（可覆盖内置）
    const userSkills = await this.loader.loadAll();
    for (const skill of userSkills) {
      this.skills.set(skill.id, skill);
    }

    console.log(`[SkillService] Loaded ${this.skills.size} skills`);
  }

  // 获取所有 Skills
  listSkills(opts?: { onlyAvailable?: boolean }): Skill[] {
    const skills = Array.from(this.skills.values());
    if (opts?.onlyAvailable) {
      return skills.filter(s => s.available && s.enabled);
    }
    return skills;
  }

  // 获取单个 Skill
  getSkill(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  // 获取 Skill（含参考文档）
  async getSkillWithReferences(id: string): Promise<SkillWithReferences | null> {
    const skill = this.skills.get(id);
    if (!skill) return null;

    if (skill.source === 'user' && skill.path) {
      return this.loader.loadWithReferences(id);
    }

    // 内置 Skill 没有 references
    return { ...skill, references: [] };
  }

  // 启用/禁用 Skill
  setEnabled(id: string, enabled: boolean): boolean {
    const skill = this.skills.get(id);
    if (!skill) return false;
    skill.enabled = enabled;
    return true;
  }

  // 重新加载用户 Skills
  async reload(): Promise<void> {
    // 保留内置 Skills
    const builtins = Array.from(this.skills.values())
      .filter(s => s.source === 'builtin');

    this.skills.clear();

    for (const skill of builtins) {
      this.skills.set(skill.id, skill);
    }

    const userSkills = await this.loader.loadAll();
    for (const skill of userSkills) {
      this.skills.set(skill.id, skill);
    }
  }

  // 搜索 Skills
  search(query: string): Skill[] {
    const lower = query.toLowerCase();
    return this.listSkills().filter(skill =>
      skill.name.toLowerCase().includes(lower) ||
      skill.description.toLowerCase().includes(lower) ||
      skill.metadata.tags?.some(t => t.toLowerCase().includes(lower))
    );
  }

  // 获取匹配的 Skills（基于上下文）
  getRelevantSkills(context: {
    task?: string;
    tools?: string[];
    tags?: string[];
  }): Skill[] {
    return this.listSkills({ onlyAvailable: true }).filter(skill => {
      // 按标签匹配
      if (context.tags?.length) {
        const skillTags = skill.metadata.tags || [];
        if (context.tags.some(t => skillTags.includes(t))) {
          return true;
        }
      }

      // 按任务关键词匹配
      if (context.task) {
        const lower = context.task.toLowerCase();
        if (skill.name.toLowerCase().includes(lower) ||
            skill.description.toLowerCase().includes(lower)) {
          return true;
        }
      }

      return false;
    });
  }
}
```

### Step 4: 内置 Skills 定义

```typescript
// src/main/skills/builtinSkills.ts
import { Skill } from '@shared/types/skill';

export const builtinSkills: Skill[] = [
  {
    id: 'file-organizer',
    name: 'File Organizer',
    description: '整理目录文件：分析、分类、检测重复、清理',
    content: `
# File Organizer

整理指定目录的文件。

## 能力
- 分析文件类型分布
- 检测重复文件（基于内容哈希）
- 按类型/日期/大小分类
- 建议清理方案

## 使用方式
告诉我要整理哪个目录，我会分析并提供建议。

## 安全提示
- 删除操作需要你确认
- 可以选择移动到废纸篓或永久删除
    `.trim(),
    metadata: {
      emoji: '📁',
      tags: ['file', 'organize', 'cleanup'],
    },
    source: 'builtin',
    enabled: true,
    available: true,
  },
  {
    id: 'commit',
    name: 'Git Commit',
    description: '智能 Git 提交助手，遵循 conventional commit 规范',
    content: `
# Git Commit

帮你生成规范的 Git 提交信息。

## 流程
1. 检查 git status
2. 分析变更内容
3. 生成 conventional commit 格式的提交信息
4. 等待你确认后提交

## Conventional Commit 格式
- feat: 新功能
- fix: Bug 修复
- docs: 文档更新
- style: 代码格式
- refactor: 重构
- test: 测试
- chore: 构建/工具

## 使用方式
直接说 "帮我提交" 或 "commit"
    `.trim(),
    metadata: {
      emoji: '📝',
      tags: ['git', 'commit', 'vcs'],
      requires: {
        bins: ['git'],
      },
    },
    source: 'builtin',
    enabled: true,
    available: true,
  },
  {
    id: 'code-review',
    name: 'Code Review',
    description: '代码审查，检查 bug、安全问题、最佳实践',
    content: `
# Code Review

帮你审查代码质量。

## 检查项
- 潜在 Bug
- 安全漏洞
- 性能问题
- 代码风格
- 最佳实践
- 可读性

## 使用方式
- 指定文件: "review src/api/user.ts"
- 指定目录: "review src/api/"
- 最近改动: "review 最近的改动"
    `.trim(),
    metadata: {
      emoji: '🔍',
      tags: ['review', 'code', 'quality'],
    },
    source: 'builtin',
    enabled: true,
    available: true,
  },
];
```

### Step 5: 集成到 Agent

```typescript
// 修改 src/main/tools/gen4/skill.ts
export async function executeSkill(
  skillId: string,
  input: string,
  context: ToolContext,
): Promise<ToolResult> {
  const skillService = context.services.skill;
  const skill = await skillService.getSkillWithReferences(skillId);

  if (!skill) {
    return { error: `Skill not found: ${skillId}` };
  }

  if (!skill.available) {
    return { error: `Skill unavailable: ${skill.unavailableReason}` };
  }

  // 将 Skill 内容注入到对话上下文
  const skillContext = [
    `# Skill: ${skill.name}`,
    skill.content,
    skill.references.length > 0 ? '\n## References\n' : '',
    ...skill.references.map(ref => `### ${ref.name}\n${ref.content}`),
  ].join('\n');

  // 通过系统消息注入 Skill 知识
  context.session.injectSystemMessage(skillContext);

  return {
    message: `已加载 Skill: ${skill.name}`,
    skillContent: skill.content,
  };
}
```

### Step 6: UI 支持

```typescript
// src/renderer/components/features/settings/SkillsTab.tsx
export function SkillsTab() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [filter, setFilter] = useState<'all' | 'enabled' | 'disabled'>('all');

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3>技能管理</h3>
        <div className="flex gap-2">
          <Select value={filter} onChange={setFilter}>
            <option value="all">全部</option>
            <option value="enabled">已启用</option>
            <option value="disabled">已禁用</option>
          </Select>
          <Button onClick={handleOpenSkillsDir}>打开技能目录</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {skills.map(skill => (
          <SkillCard
            key={skill.id}
            skill={skill}
            onToggle={() => handleToggle(skill.id)}
            onView={() => handleView(skill)}
          />
        ))}
      </div>

      <div className="mt-6 p-4 bg-gray-50 rounded">
        <h4>创建自定义技能</h4>
        <p className="text-sm text-gray-600">
          在 <code>~/.code-agent/skills/</code> 目录下创建文件夹，
          添加 <code>SKILL.md</code> 文件即可。
        </p>
        <Button className="mt-2" variant="outline" onClick={handleCreateSkill}>
          创建新技能
        </Button>
      </div>
    </div>
  );
}

function SkillCard({ skill, onToggle, onView }) {
  return (
    <div className={`p-3 border rounded ${!skill.available ? 'opacity-50' : ''}`}>
      <div className="flex items-center gap-2">
        <span className="text-xl">{skill.metadata.emoji || '🔧'}</span>
        <div className="flex-1">
          <div className="font-medium">{skill.name}</div>
          <div className="text-sm text-gray-500">{skill.description}</div>
        </div>
        <Switch
          checked={skill.enabled}
          disabled={!skill.available}
          onChange={onToggle}
        />
      </div>
      {!skill.available && (
        <div className="mt-2 text-xs text-red-500">
          {skill.unavailableReason}
        </div>
      )}
      <div className="mt-2 flex gap-1">
        {skill.metadata.tags?.map(tag => (
          <span key={tag} className="px-1 py-0.5 bg-gray-100 text-xs rounded">
            {tag}
          </span>
        ))}
      </div>
      <Button size="sm" variant="ghost" className="mt-2" onClick={onView}>
        查看详情
      </Button>
    </div>
  );
}
```

### Step 7: 用户 Skill 目录结构

```
~/.code-agent/skills/
├── my-api-helper/
│   ├── SKILL.md
│   └── references/
│       └── api-docs.md
├── project-setup/
│   └── SKILL.md
└── custom-review/
    └── SKILL.md
```

**示例 SKILL.md:**

```markdown
---
name: my-api-helper
description: 帮助调用和调试我的 API
metadata: {"emoji":"🔌","requires":{"envVars":["MY_API_KEY"]},"tags":["api","debug"]}
---

# My API Helper

这个技能帮助你调用和调试我的内部 API。

## 认证

使用环境变量 `MY_API_KEY` 进行认证。

## 常用端点

- `GET /users` - 获取用户列表
- `POST /users` - 创建用户
- `GET /users/:id` - 获取用户详情

## 示例

```bash
curl -H "Authorization: Bearer $MY_API_KEY" https://api.example.com/users
```
```

## 验收标准

1. **Skill 加载**：自动扫描并加载用户 Skills
2. **依赖检查**：检查并显示依赖状态
3. **启用/禁用**：可以启用或禁用单个 Skill
4. **References**：支持加载参考文档
5. **搜索**：支持按名称、描述、标签搜索
6. **UI 管理**：可通过界面管理 Skills
7. **热重载**：支持重新加载用户 Skills

## 风险与注意事项

1. **安全性**：用户 Skill 可能包含恶意内容
2. **冲突处理**：用户 Skill 与内置 Skill 同名时的优先级
3. **版本管理**：Skill 更新时的兼容性

## 参考资料

- [Clawdbot skills/](https://github.com/clawdbot/clawdbot/tree/main/skills)
- [gray-matter](https://github.com/jonschlinkert/gray-matter) - YAML frontmatter 解析
