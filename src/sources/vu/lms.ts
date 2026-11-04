import { chromium, type Page } from 'playwright';
import { config } from '../../config/env.js';
import { localDateTimeToUtc } from '../../utils/time.js';
import type { VuItem } from './classic-todo.js';

const LOGIN_URL = 'https://vulms.vu.edu.pk/';
const TODO_URL = 'https://vulms.vu.edu.pk/ActivityCalendar/ActivityCalendar.aspx';
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface ClassicTodoTable {
  headers: string[];
  rows: string[][];
}

export interface ClassicTodoTables {
  assignments: ClassicTodoTable;
  quizzes: ClassicTodoTable;
}

async function readTable(page: Page, id: string): Promise<ClassicTodoTable> {
  const rows = [];
  const rowLocators = await page.locator(`#${id} tr`).all();
  if (rowLocators.length > 501) throw new Error('VU Classic To Do table has too many rows');
  for (const row of rowLocators) {
    const cells = await row.locator(':scope > th, :scope > td').allInnerTexts();
    rows.push(cells.map((cell) => cell.split(/\r?\n/, 1)[0]!.trim()));
  }
  return { headers: rows[0] ?? [], rows: rows.slice(1) };
}

function parseDueDate(value: string, kind: VuItem['kind']): Pick<VuItem, 'dueAt' | 'duePrecision'> {
  const match = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4})(?: (\d{1,2}):(\d{2}) (AM|PM))?$/.exec(value);
  if (!match) throw new Error('VU Classic To Do has an unrecognized due date');
  const [, monthName, rawDay, year, rawHour, minute, period] = match;
  if (kind === 'quiz' && !rawHour) throw new Error('VU quiz has no due time');
  if (rawHour && (Number(rawHour) < 1 || Number(rawHour) > 12))
    throw new Error('VU Classic To Do has an invalid due time');
  const month = String(months.indexOf(monthName!) + 1).padStart(2, '0');
  const day = rawDay!.padStart(2, '0');
  const date = `${year}-${month}-${day}`;
  const hour = rawHour ? (Number(rawHour) % 12) + (period === 'PM' ? 12 : 0) : 23;
  const time = `${String(hour).padStart(2, '0')}:${minute ?? '59'}`;
  return { dueAt: localDateTimeToUtc(date, time), duePrecision: rawHour ? 'time' : 'date' };
}

export function parseClassicTodoTables(tables: ClassicTodoTables): VuItem[] {
  const items: VuItem[] = [];
  const seen = new Set<string>();
  for (const [kind, table] of [
    ['assignment', tables.assignments],
    ['quiz', tables.quizzes],
  ] as const) {
    const expectedTitle = kind === 'assignment' ? 'Assignment' : 'Title';
    if (table.rows.length > 500) throw new Error('VU Classic To Do is limited to 500 rows per table');
    if ([table.headers, ...table.rows].every(
      (row) => row.length === 1 && /^No .+ pending/i.test(row[0] ?? ''),
    )) continue;
    if (table.headers.slice(0, 4).join('|') !== `Course|${expectedTitle}|Open Date|Due Date`)
      throw new Error(`VU ${kind} table layout changed`);
    for (const row of table.rows) {
      if (row.length === 1 && /^No .+ pending/i.test(row[0] ?? '')) continue;
      if (row.length !== 5) throw new Error(`VU ${kind} table row layout changed`);
      const [course, title, , due] = row.map((value) => value.trim());
      if (!course || !title || !due || course.length > 100 || title.length > 300)
        throw new Error(`VU ${kind} table has an invalid row`);
      const externalId = `${kind}:${course.toLowerCase()}:${title.toLowerCase()}`;
      if (externalId.length > 500 || seen.has(externalId))
        throw new Error(`VU ${kind} table has a duplicate or overlong item`);
      seen.add(externalId);
      items.push({ externalId, kind, course, title, ...parseDueDate(due, kind) });
    }
  }
  return items;
}

export async function fetchClassicTodoItems(): Promise<VuItem[]> {
  if (!config.VU_STUDENT_ID || !config.VU_PASSWORD)
    throw new Error('VU LMS credentials are not configured');

  const browserEnv = Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME']
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]!]),
  );
  const browser = await chromium.launch({ headless: true, env: browserEnv });
  try {
    const page = await browser.newPage({ acceptDownloads: false });
    page.setDefaultTimeout(30_000);
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (new URL(page.url()).origin !== new URL(LOGIN_URL).origin)
      throw new Error('VU LMS login redirected outside the official site');
    await page.locator('#txtStudentID').fill(config.VU_STUDENT_ID);
    await page.locator('#txtPassword').fill(config.VU_PASSWORD);
    try {
      await page.waitForFunction(
        () => Boolean(document.querySelector<HTMLInputElement>('[name="g-recaptcha-response"]')?.value),
        undefined,
        { timeout: 30_000 },
      );
    } catch {
      throw new Error('VU LMS verification did not become ready');
    }
    await page.locator('#ibtnLogin').click();
    try {
      await page.waitForURL((url) => /home/i.test(url.pathname), { timeout: 30_000 });
    } catch {
      throw new Error('VU LMS sign-in was not completed; check credentials or verification');
    }
    await page.goto(TODO_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (new URL(page.url()).pathname !== new URL(TODO_URL).pathname)
      throw new Error('VU Classic To Do page did not open after sign-in');
    await page.locator('#tabHClassic').click();
    await page.locator('#MainContent_gvAssignmentsToDo tr').first().waitFor({ state: 'attached' });
    await page.locator('#MainContent_gvQuizzesToDo tr').first().waitFor({ state: 'attached' });
    const tables = {
      assignments: await readTable(page, 'MainContent_gvAssignmentsToDo'),
      quizzes: await readTable(page, 'MainContent_gvQuizzesToDo'),
    };
    return parseClassicTodoTables(tables);
  } finally {
    await browser.close();
  }
}
