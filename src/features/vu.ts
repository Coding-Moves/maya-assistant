import { upsertVuItems } from '../sources/vu/classic-todo.js';
import { fetchClassicTodoItems } from '../sources/vu/lms.js';

export async function syncVuClassicTodo(): Promise<{ created: number; updated: number; unchanged: number }> {
  const items = await fetchClassicTodoItems();
  return upsertVuItems(items);
}
