// ============================================================================
// 云下发角色包货架词条（features/expert/RolePackShelf）
// ============================================================================

export const rolePackZh = {
  rolePack: {
    sectionTitle: '更多专家',
    loading: '正在加载更多专家…',
    loadFailed: '暂时无法加载更多专家，请重试。',
    retryLoad: '重试',
    empty: '暂时没有更多专家。',
    skills: '技能',
    tools: '工具',
    publisher: '发布方',
    version: '版本',
    install: '安装',
    uninstall: '卸载',
    upgrade: '升级',
    installed: '已安装',
    degraded: '{count} 项技能不可用',
    missingSkills: '不可用技能：{skills}',
    retryMissingSkills: '重试补装',
    locallyModified: '你已改过这个专家，更新不会覆盖你的改动',
    actionFailed: '操作未完成，请重试。',
  },
};

export const rolePackEn: typeof rolePackZh = {
  rolePack: {
    sectionTitle: 'More experts',
    loading: 'Loading more experts…',
    loadFailed: 'More experts could not be loaded. Please try again.',
    retryLoad: 'Retry',
    empty: 'No more experts are available right now.',
    skills: 'Skills',
    tools: 'Tools',
    publisher: 'Publisher',
    version: 'Version',
    install: 'Install',
    uninstall: 'Uninstall',
    upgrade: 'Upgrade',
    installed: 'Installed',
    degraded: '{count} skills unavailable',
    missingSkills: 'Unavailable skills: {skills}',
    retryMissingSkills: 'Retry installation',
    locallyModified: 'You changed this expert; updating will not overwrite your changes.',
    actionFailed: 'The action did not complete. Please try again.',
  },
};
