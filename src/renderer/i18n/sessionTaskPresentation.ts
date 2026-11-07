import { outcomeWordsEn, outcomeWordsZh } from './outcomeWords';

export const sessionTaskPresentationZh = {
  sessionTaskPresentation: {
    accepted: '已在后台开始：{name}，完成后会告诉你。',
    queued: '已排队：{name}，轮到它时会自动开始。',
    reused: '继续跟踪后台任务：{name}　{status}',
    statusLine: '{name}　{status}{detail}',
    detail: '：{detail}',
    status: {
      queued: '等待开始',
      running: '进行中',
      cancelling: '正在中断',
      completed: outcomeWordsZh.outcomeWords.completed.timeline.label,
      failed: outcomeWordsZh.outcomeWords['failed-unknown'].badge.label,
      cancelled: outcomeWordsZh.outcomeWords['interrupted-unknown'].badge.label,
    },
  },
};

export const sessionTaskPresentationEn: typeof sessionTaskPresentationZh = {
  sessionTaskPresentation: {
    accepted: "Started in the background: {name}. I'll tell you when it's done.",
    queued: 'Queued: {name}. It will start automatically when its turn comes.',
    reused: 'Continuing to track: {name} — {status}',
    statusLine: '{name}　{status}{detail}',
    detail: ': {detail}',
    status: {
      queued: 'Waiting to start',
      running: 'Running',
      cancelling: 'Stopping',
      completed: outcomeWordsEn.outcomeWords.completed.timeline.label,
      failed: outcomeWordsEn.outcomeWords['failed-unknown'].badge.label,
      cancelled: outcomeWordsEn.outcomeWords['interrupted-unknown'].badge.label,
    },
  },
};
