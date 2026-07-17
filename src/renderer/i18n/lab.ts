// ============================================================================
// 实验室域词条（LabPage 主页面）—— zh/en 同文件相邻维护。
// 独立文件避免 zh.ts/en.ts 撞 max-lines 棘轮（同 chatInput.ts / sidebar.ts 先例）。
// 四个子实验室（gpt1/nanogpt/alignment/llamafactory）各自的词条在 labGpt1.ts /
// labNanogpt.ts / labAlignment.ts / labLlamafactory.ts。
// ============================================================================

export const labZh = {
  lab: {
    title: '实验室',
    subtitle: '模型训练学习平台入口',
    closeLabel: '关闭 实验室',
    heroTitle: 'AI 学习实验室',
    heroSubtitle: '不需要任何编程基础，通过动手实验，亲眼看看 AI 是怎么一步步学会"说话"的',
    recommendedPath: '推荐学习顺序',
    pathHint: '建议从第一个实验开始，每个实验大约需要 15-30 分钟',
    startLearning: '开始学习',
    comingSoon: '即将开放',
    pathSteps: ['① 学说话', '② 读更多书', '③ 学会听话', '④ 微调进阶'],
    cards: {
      gpt1: {
        title: '教 AI 学说话',
        subtitle: '从零开始，亲手训练一个会聊天的 AI',
        description: '就像教小孩说话一样：先给它听对话、教它认字、建立语言能力、反复练习，最后它就能自己说话了。',
        level: '入门级',
        params: '约 1100 万个"脑细胞"',
      },
      nanogpt: {
        title: '让 AI 读更多书',
        subtitle: '训练一个能写莎士比亚风格文章的 AI',
        description: '如果说第一个实验是教 AI 说日常对话，这个实验就是让它读大量书籍，学会更复杂的写作风格。',
        level: '进阶级',
        params: '约 1000 万~1.2 亿个"脑细胞"',
      },
      alignment: {
        title: '让 AI 学会听话',
        subtitle: '教 AI 按照人类的要求来回答',
        description: 'AI 学会说话后，还要学会"听指令"。这个实验教你如何让 AI 更好地理解和执行人类的要求。',
        level: '高级',
        params: '在已训练模型上调整',
      },
      llamafactory: {
        title: '让 AI 更专业',
        subtitle: '训练一个领域专家 AI',
        description: '微调就像培养专才：牺牲一点通用能力，换取在特定领域的专业表现。学习 SFT、DPO 等主流技术。',
        level: '高级',
        params: '概念演示模式',
      },
    },
  },
};

export const labEn = {
  lab: {
    title: 'Lab',
    subtitle: 'A hands-on entry point for learning how models are trained',
    closeLabel: 'Close Lab',
    heroTitle: 'AI Learning Lab',
    heroSubtitle: 'No coding background needed — hands-on experiments let you watch, step by step, how AI learns to "talk"',
    recommendedPath: 'Recommended order',
    pathHint: 'Start with the first experiment — each one takes about 15-30 minutes',
    startLearning: 'Start learning',
    comingSoon: 'Coming soon',
    pathSteps: ['① Learn to talk', '② Read more books', '③ Learn to follow instructions', '④ Fine-tuning'],
    cards: {
      gpt1: {
        title: 'Teach AI to talk',
        subtitle: 'Train a chatty AI from scratch, hands-on',
        description: 'Like teaching a child to speak: let it listen to conversations, learn characters, build language ability, practice repeatedly — until it can talk on its own.',
        level: 'Beginner',
        params: '~11M "brain cells"',
      },
      nanogpt: {
        title: 'Have AI read more',
        subtitle: 'Train an AI that writes in a Shakespearean style',
        description: 'If the first experiment taught AI everyday conversation, this one has it read a large body of books to learn a more complex writing style.',
        level: 'Intermediate',
        params: '~10M-120M "brain cells"',
      },
      alignment: {
        title: 'Teach AI to follow instructions',
        subtitle: 'Get AI to answer the way humans ask it to',
        description: 'Once AI can talk, it also needs to learn to "follow instructions." This experiment teaches you how to help AI better understand and carry out human requests.',
        level: 'Advanced',
        params: 'Tuned on top of an already-trained model',
      },
      llamafactory: {
        title: 'Make AI more specialized',
        subtitle: 'Train a domain-expert AI',
        description: 'Fine-tuning is like training a specialist: trade a bit of general ability for stronger performance in a specific domain. Learn mainstream techniques like SFT and DPO.',
        level: 'Advanced',
        params: 'Concept demo mode',
      },
    },
  },
};
