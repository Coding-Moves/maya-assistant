import { chromium, type Page } from 'playwright';
import { localDateTimeToUtc } from '../../utils/time.js';

const LOGIN_URL = 'https://www.cms.nfciet.com/login';
const ASSIGNMENTS_URL = 'https://www.cms.nfciet.com/student/assignments';
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface NfcAssignment {
  externalId: string;
  course: string;
  title: string;
  marks: string | null;
  dueAt: string;
  status: 'open' | 'submitted' | 'reviewing' | 'graded' | 'expired' | 'unknown';
  portalUrl: string;
}

export interface NfcCredentials { studentId: string; password: string }

function normalizedStatus(value: string): NfcAssignment['status'] {
  const input = value.toLocaleLowerCase();
  if (input.includes('expired') || input.includes('closed')) return 'expired';
  if (input.includes('submitted')) return 'submitted';
  if (input.includes('review')) return 'reviewing';
  if (input.includes('graded')) return 'graded';
  if (input.includes('open') || input.includes('pending') || input.includes('active')) return 'open';
  return 'unknown';
}

export function parseNfcDueDate(value: string): string {
  const match = /^(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}), (\d{1,2}):(\d{2}) (AM|PM)$/u.exec(value.trim());
  if (!match) throw new Error('NFC CMS has an unrecognized assignment deadline');
  const [, rawDay, monthName, year, rawHour, minute, period] = match;
  const hour = (Number(rawHour) % 12) + (period === 'PM' ? 12 : 0);
  if (Number(rawHour) < 1 || Number(rawHour) > 12 || Number(minute) > 59) throw new Error('NFC CMS has an invalid assignment deadline');
  return localDateTimeToUtc(`${year}-${String(months.indexOf(monthName!) + 1).padStart(2, '0')}-${rawDay!.padStart(2, '0')}`,
    `${String(hour).padStart(2, '0')}:${minute}`);
}

export function parseNfcAssignmentRows(rows: readonly { cells: string[]; href: string | null }[]): NfcAssignment[] {
  const ids = new Set<string>();
  return rows.map(({ cells, href }) => {
    if (cells.length !== 6 || !href) throw new Error('NFC CMS assignment table layout changed');
    const [title, course, marks, due, status] = cells.map((cell) => cell.trim());
    const id = /\/student\/assignments\/(\d+)$/u.exec(new URL(href).pathname)?.[1];
    if (!id || ids.has(id) || !title || !course) throw new Error('NFC CMS assignment row is invalid');
    ids.add(id);
    return { externalId: id, title: title.slice(0, 300), course: course.slice(0, 100), marks: marks || null,
      dueAt: parseNfcDueDate(due ?? ''), status: normalizedStatus(status ?? ''), portalUrl: href };
  });
}

async function assignmentRows(page: Page): Promise<{ cells: string[]; href: string | null }[]> {
  const rows = await page.locator('table tr').all();
  if (rows.length > 501) throw new Error('NFC CMS has too many assignments');
  const result: { cells: string[]; href: string | null }[] = [];
  for (const row of rows.slice(1)) {
    result.push({
      cells: (await row.locator(':scope > th, :scope > td').allInnerTexts()).map((cell) => cell.trim()),
      href: await row.locator('a[href*="/student/assignments/"]').getAttribute('href'),
    });
  }
  return result;
}

export async function fetchNfcAssignments(credentials: NfcCredentials): Promise<NfcAssignment[]> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ acceptDownloads: false });
    page.setDefaultTimeout(30_000);
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (new URL(page.url()).origin !== new URL(LOGIN_URL).origin) throw new Error('NFC CMS login redirected outside the official site');
    await page.locator('input[name="email"]').fill(credentials.studentId);
    await page.locator('input[name="password"]').fill(credentials.password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((url) => url.pathname === '/student/dashboard', { timeout: 30_000 });
    await page.goto(ASSIGNMENTS_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (new URL(page.url()).pathname !== '/student/assignments') throw new Error('NFC CMS assignments page did not open after sign-in');
    return parseNfcAssignmentRows(await assignmentRows(page));
  } finally {
    await browser.close();
  }
}
