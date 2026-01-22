/**
 * Constitution - Code Agent 宪法
 * 汇总导出所有宪法组件
 */

import { SOUL } from './soul';
import { VALUES } from './values';
import { ETHICS } from './ethics';
import { HARD_CONSTRAINTS } from './hardConstraints';
import { SAFETY } from './safety';
import { JUDGMENT } from './judgment';

/**
 * 完整的 Code Agent 宪法
 * 所有代际共享，定义 Agent 的身份、价值观和行为准则
 */
export const CONSTITUTION = `
# Code Agent 宪法

${SOUL}

${VALUES}

${ETHICS}

${HARD_CONSTRAINTS}

${SAFETY}

${JUDGMENT}
`.trim();

// 导出各个组件，供需要单独使用的场景
export { SOUL, VALUES, ETHICS, HARD_CONSTRAINTS, SAFETY, JUDGMENT };
