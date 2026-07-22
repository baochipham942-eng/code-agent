// ============================================================================
// 组队配方入口词条（features/expert/ExpertPanel 的组队区）—— zh/en 同文件相邻维护。
// 独立文件避免 zh.ts/en.ts 撞 max-lines 棘轮（同 knowledgeMemory.ts / chatInput.ts 先例）。
// ============================================================================

export const teamZh = {
  team: {
    sectionTitle: '组队',
    useRecipe: '用这个配方',
    topicPlaceholder: '这次让团队做什么主题？',
    topicRequired: '请先填主题',
    launch: '起团队',
  },
};

export const teamEn: typeof teamZh = {
  team: {
    sectionTitle: 'Team up',
    useRecipe: 'Use this recipe',
    topicPlaceholder: 'What topic for this team?',
    topicRequired: 'Enter a topic first',
    launch: 'Launch',
  },
};
