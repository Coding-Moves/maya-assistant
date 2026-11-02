import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer } from 'node:http';
import 'dotenv/config';

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) throw new Error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first');

const state = randomBytes(24).toString('hex');
const verifier = randomBytes(48).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const server = createServer();
server.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Could not start local OAuth callback');
const redirectUri = `http://127.0.0.1:${address.port}/callback`;
const consent = new URL('https://accounts.google.com/o/oauth2/v2/auth');
consent.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: 'https://www.googleapis.com/auth/calendar.events',
  access_type: 'offline',
  prompt: 'consent',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state,
}).toString();

console.log('Open this URL in a browser on this computer and approve Calendar access:');
console.log(consent.toString());
const code = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => {
    server.close();
    reject(new Error('Calendar authorization timed out after 10 minutes'));
  }, 10 * 60_000);
  server.on('request', (request, response) => {
    const url = new URL(request.url ?? '/', redirectUri);
    if (url.pathname !== '/callback') {
      response.writeHead(404).end();
      return;
    }
    const received = url.searchParams.get('code');
    const valid = url.searchParams.get('state') === state;
    response.writeHead(valid && received ? 200 : 400, { 'Content-Type': 'text/plain' })
      .end(valid && received ? 'Calendar connected. You can close this tab.' : 'Calendar authorization failed.');
    clearTimeout(timer);
    server.close();
    if (valid && received) resolve(received);
    else reject(new Error('Calendar authorization was denied or state did not match'));
  });
});

const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    grant_type: 'authorization_code',
  }),
});
if (!tokenResponse.ok) throw new Error(`Calendar token exchange failed (${tokenResponse.status})`);
const token = await tokenResponse.json() as { refresh_token?: string };
if (!token.refresh_token) throw new Error('Google did not issue a refresh token; check OAuth consent and retry');
const env = readFileSync('.env', 'utf8');
const line = `GOOGLE_REFRESH_TOKEN=${token.refresh_token}`;
const updated = /^GOOGLE_REFRESH_TOKEN=.*$/m.test(env)
  ? env.replace(/^GOOGLE_REFRESH_TOKEN=.*$/m, line)
  : `${env.trimEnd()}\n${line}\n`;
writeFileSync('.env', updated, { mode: 0o600 });
chmodSync('.env', 0o600);
console.log('Saved GOOGLE_REFRESH_TOKEN to .env. Keep this file private.');
