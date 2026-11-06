import { upsertVuItems } from '../sources/vu/classic-todo.js';
import { fetchClassicTodoItems } from '../sources/vu/lms.js';
import { db } from '../db/client.js';

export async function syncVuClassicTodo(
  fetchItems: typeof fetchClassicTodoItems = fetchClassicTodoItems,
  apply: typeof upsertVuItems = upsertVuItems,
): Promise<{ created: number; updated: number; unchanged: number }> {
  try {
    const items = await fetchItems();
    const result = apply(items);
    db.prepare(`INSERT INTO source_sync_state (source, last_success_at, last_failure_at)
      VALUES ('vu-classic-todo', ?, NULL) ON CONFLICT(source) DO UPDATE SET
      last_success_at = excluded.last_success_at, last_failure_at = NULL`).run(new Date().toISOString());
    return result;
  } catch (error) {
    db.prepare(`INSERT INTO source_sync_state (source, last_failure_at)
      VALUES ('vu-classic-todo', ?) ON CONFLICT(source) DO UPDATE SET
      last_failure_at = excluded.last_failure_at`).run(new Date().toISOString());
    throw error;
  }
}
