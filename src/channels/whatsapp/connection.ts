import makeWASocket, { DisconnectReason, useMultiFileAuthState, type WASocket } from 'baileys';
import qrcode from 'qrcode-terminal';
import { config } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { acquireAuthSessionLock, AuthSessionInUseError } from './auth-lock.js';
import { clearOwnerIdentity, configuredOwnerIdentity, resolveOwnerIdentity, setOwnerIdentity } from './identity.js';

// Baileys may include raw WhatsApp nodes in warning/error logs.
const baileysLogger = logger.child({ module: 'baileys' }, { level: 'silent' });
const maxReconnectDelayMs = 5 * 60 * 1000;

let socket: WASocket | null = null;
let socketOpen = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectDelayMs = 1000;
let connectWork: Promise<void> | null = null;
let stopWork: Promise<void> | null = null;
let stopping = false;
let releaseAuthSessionLock: (() => void) | null = null;
let detachRouter: (() => void) | null = null;
let flushActiveCredentials: (() => Promise<void>) | null = null;
let pendingCredentialSave = Promise.resolve();

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
      logger.error(
        { errorType: error instanceof Error ? error.name : 'unknown' },
        'Could not save WhatsApp credentials',
      );
      logger.debug({ err: error }, 'Credential save failure details');
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
  if (stopping || reconnectTimer) return;
  const delayMs = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, maxReconnectDelayMs);
  logger.warn({ delayMs }, 'WhatsApp disconnected; reconnecting');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (stopping) return;
    void afterSave.then(connectToWhatsApp);
  }, delayMs);
}

export function connectToWhatsApp(): Promise<void> {
  if (stopping || socket || reconnectTimer) return Promise.resolve();
  if (connectWork) return connectWork;
  connectWork = startConnection().finally(() => {
    connectWork = null;
  });
  return connectWork;
}

async function startConnection(): Promise<void> {
  try {
    releaseAuthSessionLock ??= acquireAuthSessionLock();
    const { attachWhatsAppRouter } = await import('./router.js');
    const { socket: nextSocket, flushCredentials } = await createWhatsAppSocket();
    if (stopping) {
      try {
        await nextSocket.end(undefined);
      } finally {
        await flushCredentials();
      }
      return;
    }
    socket = nextSocket;
    socketOpen = false;
    detachRouter = attachWhatsAppRouter(nextSocket);
    flushActiveCredentials = flushCredentials;

    nextSocket.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (socket !== nextSocket) return;
      if (qr) qrcode.generate(qr, { small: true });

      if (connection === 'open') {
        if (config.BOT_MODE === 'separate')
          setOwnerIdentity(configuredOwnerIdentity());
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
          logger.error(
            { errorType: error instanceof Error ? error.name : 'unknown' },
            'Could not resolve owner identity',
          );
          logger.debug({ err: error }, 'Owner identity failure details');
        });
      }

      if (connection === 'close') {
        socketOpen = false;
        detachRouter?.();
        detachRouter = null;
        socket = null;
        flushActiveCredentials = null;
        clearOwnerIdentity();
        pendingCredentialSave = flushCredentials();
        if (stopping) return;
        const code = disconnectCode(lastDisconnect?.error);
        if (code === DisconnectReason.loggedOut) {
          logger.error(`WhatsApp logged out. Delete ${config.AUTH_DIR} and rescan the QR code.`);
          process.exit(1);
        }
        if (code === DisconnectReason.restartRequired) {
          logger.info('WhatsApp requested a restart after pairing');
        }
        scheduleReconnect(pendingCredentialSave);
      }
    });
  } catch (error) {
    socket = null;
    socketOpen = false;
    clearOwnerIdentity();
    logger.error(
      { errorType: error instanceof Error ? error.name : 'unknown' },
      'Could not start WhatsApp connection',
    );
    logger.debug({ err: error }, 'WhatsApp connection failure details');
    if (stopping || error instanceof AuthSessionInUseError) throw error;
    scheduleReconnect();
  }
}

export function pauseWhatsApp(): void {
  stopping = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  detachRouter?.();
  detachRouter = null;
}

export function stopWhatsApp(): Promise<void> {
  if (stopWork) return stopWork;
  pauseWhatsApp();
  stopWork = (async () => {
    try {
      if (connectWork) await connectWork;
    } finally {
      try {
        const { waitForOwnerReplies } = await import('./router.js');
        await waitForOwnerReplies();
      } finally {
        const currentSocket = socket;
        const flush = flushActiveCredentials;
        socket = null;
        socketOpen = false;
        flushActiveCredentials = null;
        clearOwnerIdentity();
        try {
          if (currentSocket) await currentSocket.end(undefined);
        } finally {
          try {
            await flush?.();
            await pendingCredentialSave;
          } finally {
            releaseAuthSessionLock?.();
            releaseAuthSessionLock = null;
          }
        }
      }
    }
  })();
  return stopWork;
}
