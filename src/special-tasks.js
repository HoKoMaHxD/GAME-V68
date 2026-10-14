export const SPECIAL_TASK_PAGE_SIZE = 10;
export const MAX_SPECIAL_TASKS = 100;
export const MAX_SPECIAL_REWARD = 100000;

export function seedSpecialTasks(at) {
  return [
    { id: 'special-recruit', title: 'إدخال عضو للكلان عن طريقك', reward: 250 },
    { id: 'special-event-win', title: 'الفوز في فعاليات الكلان', reward: 150 },
    { id: 'special-event-attend', title: 'حضور فعاليات الكلان', reward: 50 }
  ].map(task => ({ ...task, createdAt: at, createdBy: null }));
}

export function validateSpecialTask(input) {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > 100 || /[\r\n]/.test(title)) throw new Error('اسم المهمة الخاصة مطلوب، في سطر واحد وحتى 100 حرف.');
  if (!Number.isSafeInteger(input.reward) || input.reward < 1 || input.reward > MAX_SPECIAL_REWARD) {
    throw new Error(`نقاط المهمة الخاصة يجب أن تكون بين 1 و${MAX_SPECIAL_REWARD}.`);
  }
  return { title, reward: input.reward };
}

export function specialTaskPage(tasks = [], requested = 1) {
  const pages = Math.max(1, Math.ceil(tasks.length / SPECIAL_TASK_PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Number.isSafeInteger(requested) ? requested : 1));
  const offset = (page - 1) * SPECIAL_TASK_PAGE_SIZE;
  return { page, pages, offset, total: tasks.length, tasks: tasks.slice(offset, offset + SPECIAL_TASK_PAGE_SIZE) };
}
