import { sendToOwner } from '../channels/whatsapp/send.js';

export async function ask(_question: string): Promise<void> {
  await sendToOwner('Questions are coming in Step 8.');
}
