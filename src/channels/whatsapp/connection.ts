import makeWASocket, { DisconnectReason, useMultiFileAuthState, type WASocket } from 'baileys';
import qrcode from 'qrcode-terminal';
import { config } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { acquireAuthSessionLock, AuthSessionInUseError } from './auth-lock.js';
import { clearOwnerIdentity, resolveOwnerIdentity, setOwnerIdentity } from './identity.js';

const baileysLogger = logger.child({ module: 'baileys' }, { level: 'warn' });
const maxReconnectDelayMs = 5 * 60 * 1000;

let socket: WASocket | null = null;
let socketOpen = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectDelayMs = 1000;
let connecting = false;
let releaseAuthSessionLock: (() => void) | null = null;

export function getConnectedSocket(): WASocket | null {
  return socketOpen ? socket : null;
}

export async function createWhatsAppSocket(): Promise<{
  socket: WASocket;
  flushCredentials: () => Promise<void>;
}> {
  const { state, saveCreds } = await useMultiFileAuthState(config.AUTH_DIR);
  const socket = makeWASocket({
    auth: state,
    logger: baileysLogger,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  let pendingSave = Promise.resolve();
  socket.ev.on('creds.update', () => {
    pendingSave = pendingSave.then(saveCreds).catch((error: unknown) => {
      logger.error({ err: error }, 'Could not save WhatsApp credentials');
    });
  });

  return { socket, flushCredentials: () => pendingSave };
}

function disconnectCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('output' in error)) return undefined;
  const output = error.output;
  if (typeof output !== 'object' || output === null || !('statusCode' in output)) return undefined;
  return typeof output.statusCode === 'number' ? output.statusCode : undefined;
}

function scheduleReconnect(afterSave: Promise<void> = Promise.resolve()): void {
  if (reconnectTimer) return;
  const delayMs = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, maxReconnectDelayMs);
  logger.warn({ delayMs }, 'WhatsApp disconnected; reconnecting');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void afterSave.then(connectToWhatsApp);
  }, delayMs);
}

export async function connectToWhatsApp(): Promise<void> {
  if (connecting || socket || reconnectTimer) return;
  connecting = true;

  try {
    releaseAuthSessionLock ??= acquireAuthSessionLock();
    const { attachWhatsAppRouter } = await import('./router.js');
    const { socket: nextSocket, flushCredentials } = await createWhatsAppSocket();
    socket = nextSocket;
    socketOpen = false;
    const detachRouter = attachWhatsAppRouter(nextSocket);

    nextSocket.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (socket !== nextSocket) return;
      if (qr) qrcode.generate(qr, { small: true });

      if (connection === 'open') {
        socketOpen = true;
        reconnectDelayMs = 1000;
        const name = nextSocket.user?.name ?? nextSocket.user?.notify ?? 'WhatsApp account';
        logger.info(`Connected as ${name}`);
        void resolveOwnerIdentity(nextSocket).then((identity) => {
          if (socket !== nextSocket) return;
          setOwnerIdentity(identity);
          if (!identity) logger.warn('Owner identity is unavailable; owner chat will be ignored');
        }).catch((error: unknown) => {
          if (socket !== nextSocket) return;
          clearOwnerIdentity();
          logger.error({ err: error }, 'Could not resolve owner identity');
        });
      }

      if (connection === 'close') {
        socketOpen = false;
        detachRouter();
        socket = null;
        clearOwnerIdentity();
        const code = disconnectCode(lastDisconnect?.error);
        if (code === DisconnectReason.loggedOut) {
          logger.error(`WhatsApp logged out. Delete ${config.AUTH_DIR} and rescan the QR code.`);
          process.exit(1);
        }
        if (code === DisconnectReason.restartRequired) {
          logger.info('WhatsApp requested a restart after pairing');
        }
        scheduleReconnect(flushCredentials());
      }
    });
  } catch (error) {
    socket = null;
    socketOpen = false;
    clearOwnerIdentity();
    logger.error({ err: error }, 'Could not start WhatsApp connection');
    if (error instanceof AuthSessionInUseError) {
      process.exitCode = 1;
      return;
    }
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}
