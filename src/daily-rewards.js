import { dayKey } from './time.js';

export const DAILY_REWARD_VERSION = 1;
export const DAILY_REWARDS = Object.freeze({
  'daily-general-50': 8000,
  'daily-clan-chat-50': 6000,
  'daily-feeling-mention': 1500,
  'daily-look-media': 1000,
  'daily-voice-180': 9000,
  'daily-games-5': 5500
});
export const DAILY_ATTENDANCE = Object.freeze({ points: 10, intervalMs: 600000, dailyCap: 4000 });

// Historical seed helpers remain usable for old schema migrations. This is
// the current economy applied when installing the live daily catalog.
export function withDailyReward(task) {
  return Object.hasOwn(DAILY_REWARDS, task.id) ? { ...task, reward: DAILY_REWARDS[task.id] } : task;
}

// Reprice only unpaid assignments that already existed at upgrade. New days
// take a catalog snapshot and a version marker, preserving later admin edits.
export function updateDailyRewards(state, activatedAt) {
  if (!activatedAt || state.dailyQuestVersion !== 1 || state.rewardSetVersion === DAILY_REWARD_VERSION
    || state.day < dayKey(activatedAt)) return false;
  const changes = [];
  for (const task of state.tasks || []) {
    const reward = DAILY_REWARDS[task.id];
    if (!reward || task.completed > 0 || task.reward === reward
      || state.completionLog?.some(entry => entry.taskId === task.id && entry.at >= (state.dailyQuestStartedAt || 0))) continue;
    changes.push({ taskId: task.id, before: task.reward, after: reward });
    task.reward = reward;
  }
  state.rewardSetVersion = DAILY_REWARD_VERSION;
  state.rewardSetUpdatedAt = activatedAt;
  if (changes.length) (state.rewardChanges ||= []).push({ version: DAILY_REWARD_VERSION, at: activatedAt, changes });
  return true;
}
