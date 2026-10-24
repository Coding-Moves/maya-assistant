// libsignal logs whole session objects directly to console, including key material.
// Baileys' Pino logger does not control these calls.
const sessionMessages = new Set([
  'Closing session:',
  'Opening session:',
  'Removing old closed session:',
  'Session already closed',
]);

let installed = false;

export function suppressSignalSessionLogs(): void {
  if (installed) return;
  installed = true;

  const originalInfo = console.info.bind(console);
  const originalWarn = console.warn.bind(console);

  console.info = (...args: unknown[]) => {
    if (!sessionMessages.has(args[0] as string)) originalInfo(...args);
  };
  console.warn = (...args: unknown[]) => {
    if (!sessionMessages.has(args[0] as string)) originalWarn(...args);
  };
}
