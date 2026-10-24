import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WASocket } from 'baileys';
import { config } from '../src/config/env.js';
import { acquireAuthSessionLock } from '../src/channels/whatsapp/auth-lock.js';
import { createWhatsAppSocket } from '../src/channels/whatsapp/connection.js';
import { suppressSignalSessionLogs } from '../src/utils/signal-console.js';

function waitForConnection(socket: WASocket): Promise<void> {
  return new Promise((resolveConnection, rejectConnection) => {
    const timeout = setTimeout(() => {
      finish(
        new Error(
          'Timed out connecting to WhatsApp. Check your network and retry.',
        ),
      );
    }, 60_000);

    const onUpdate = ({
      connection,
      qr,
    }: {
      connection?: string;
      qr?: string;
    }) => {
      if (qr) {
        finish(
          new Error(
            'Saved WhatsApp session needs a new QR. Run npm run dev to reconnect first.',
          ),
        );
      } else if (connection === 'open') {
        finish();
      } else if (connection === 'close') {
        finish(
          new Error(
            'WhatsApp connection closed before the group list was available.',
          ),
        );
      }
    };

    function finish(error?: Error): void {
      clearTimeout(timeout);
      socket.ev.off('connection.update', onUpdate);
      if (error) rejectConnection(error);
      else resolveConnection();
    }

    socket.ev.on('connection.update', onUpdate);
  });
}

async function main(): Promise<void> {
  suppressSignalSessionLogs();
  const releaseLock = acquireAuthSessionLock();
  let socket: WASocket | undefined;
  let flushCredentials: (() => Promise<void>) | undefined;
  try {
    if (!existsSync(join(resolve(config.AUTH_DIR), 'creds.json'))) {
      throw new Error(
        'No saved WhatsApp session found. Run npm run dev and scan its QR first.',
      );
    }

    ({ socket, flushCredentials } = await createWhatsAppSocket());
    await waitForConnection(socket);
    const groups = Object.values(await socket.groupFetchAllParticipating());
    groups.sort((a, b) => a.subject.localeCompare(b.subject));

    if (groups.length === 0) {
      console.log('No participating groups found.');
    } else {
      console.table(
        groups.map((group) => ({
          Name: group.subject,
          JID: group.id,
          Community: group.isCommunity ? 'yes' : '',
          Announcement:
            group.announce || group.isCommunityAnnounce ? 'yes' : '',
        })),
      );
    }
  } finally {
    try {
      if (socket) {
        try {
          if (!socket.ws.isClosed) await socket.ws.close();
        } finally {
          await flushCredentials?.();
        }
      }
    } finally {
      releaseLock();
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
