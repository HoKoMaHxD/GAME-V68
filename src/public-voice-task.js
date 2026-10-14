export const PUBLIC_VOICE_TASK_ID = 'daily-public-voice-40';
export const PUBLIC_VOICE_TASK_VERSION = 1;
export const PUBLIC_VOICE_CATEGORY_IDS = Object.freeze([
  '1040414663676014623', '1050377755822395402', '766953290122395659'
]);

export function publicVoiceTemplate(installedAt) {
  return { id: PUBLIC_VOICE_TASK_ID, title: 'تواجد 40 دقيقة في الرومات العامة', type: 'voice',
    channelId: null, categoryIds: [...PUBLIC_VOICE_CATEGORY_IDS], target: 40, reward: 12000,
    repeat: 1, enabled: true, forUser: null, requiredRoleId: null, requiresMedia: false,
    order: 6, createdAt: installedAt };
}

export function availablePublicVoiceTask(templates, userId, at) {
  return templates.find(task => task.id === PUBLIC_VOICE_TASK_ID && task.enabled
    && (!task.forUser || task.forUser === userId) && (task.createdAt || 0) <= at);
}

// A separate slot preserves every existing assignment, balance and receipt.
// Installation starts a fresh counter; old clan time has no category evidence.
export function appendPublicVoiceTask(state, templates, at) {
  if (state.tasks.some(task => task.id === PUBLIC_VOICE_TASK_ID)) return false;
  const task = availablePublicVoiceTask(templates, state.userId, at);
  if (!task) return false;
  state.tasks.push({ id: task.id, title: task.title, type: 'voice', channelId: null,
    categoryIds: [...task.categoryIds], target: task.target, reward: task.reward, repeat: 1,
    enabled: true, forUser: task.forUser || null, requiredRoleId: null, requiresMedia: false,
    progress: 0, completed: 0, lastMessageId: null, availableFrom: task.createdAt || 0 });
  return true;
}
