import { db } from '../client.js';

export interface JoinedGroup {
  id: string;
  name: string | null;
}

export function rememberGroup(id: string, name: string | null): void {
  db.prepare(`INSERT INTO groups (id, name, active) VALUES (?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET name = COALESCE(excluded.name, groups.name), active = 1`)
    .run(id, name);
}

export function replaceJoinedGroups(groups: readonly JoinedGroup[]): void {
  db.transaction(() => {
    db.prepare('UPDATE groups SET active = 0').run();
    for (const group of groups) rememberGroup(group.id, group.name);
  })();
}

export function joinedGroups(): JoinedGroup[] {
  return db.prepare<[], JoinedGroup>(
    'SELECT id, name FROM groups WHERE active = 1 ORDER BY name COLLATE NOCASE, id',
  ).all();
}
