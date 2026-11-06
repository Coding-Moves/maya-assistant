import { config } from '../config/env.js';
import { sendToOwner } from '../channels/whatsapp/send.js';
import { dueOwnerReminders, markOwnerReminderSent } from '../db/repos/owner-reminders.js';

let running = false;

export async function sendDueOwnerReminders(now = new Date(), send = sendToOwner): Promise<number> {
  if (config.BOT_MODE !== 'separate' || running) return 0;
  running = true;
  let sent = 0;
  try {
    for (const reminder of dueOwnerReminders(now)) {
      if (!await send(`A little reminder: ${reminder.title}`)) break;
      if (markOwnerReminderSent(reminder.id, now)) sent += 1;
    }
    return sent;
  } finally {
    running = false;
  }
}
