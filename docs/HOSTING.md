# Hosting Maya

Maya needs a persistent disk for `data/` (SQLite) and `auth_info/` (the WhatsApp linked-device session). Run **one process per auth folder**. Stop the local copy before starting a VM or container copy. The app has no inbound web server; it needs outbound HTTPS/WebSocket access to WhatsApp and Gemini.

Use Node.js 22 or newer; Node 24 is used for development. Copy `.env.example` to `.env`, fill the required values, and keep `.env`, `auth_info/`, and `data/` private. Never put them in an image or Git commit. `useMultiFileAuthState` is convenient for one personal bot, but it writes many credential files; use a persistent, access-restricted directory and revisit the storage design before broader use.

## Linux with systemd (the current Oracle VM)

Install dependencies with `npm ci`. Create a dedicated unprivileged user that owns the project, `.env`, `auth_info/`, and `data/`. Set `.env` to mode `0600` and the two private directories to `0700`. Scan the QR once before enabling unattended startup.

Create `/etc/systemd/system/maya.service` with paths and user adapted to your host:

```ini
[Unit]
Description=Maya WhatsApp assistant
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=maya
Group=maya
WorkingDirectory=/opt/maya-assistant
ExecStart=/usr/local/bin/node --import tsx src/index.ts
Restart=on-failure
RestartSec=15
TimeoutStopSec=70
UMask=0077
Environment=NODE_ENV=production
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Run `sudo systemctl daemon-reload && sudo systemctl enable --now maya`, then check `sudo systemctl status maya` and `sudo journalctl -u maya -n 30 --no-pager`. This VM already runs Maya with systemd; do not start PM2 or Docker on it at the same time.

## PM2 on another persistent host

Install PM2 from npm on that host, run `npm ci`, and start `pm2 start ecosystem.config.cjs`. The ecosystem file uses a single Node process and gives Maya up to 65 seconds to finish shutdown. Arrange for PM2 to start on boot using its documented startup command. Keep the working directory and private files on persistent storage.

## Docker on another persistent host

Build with `docker build -t maya-assistant .`. The build excludes `.env`, sessions, and databases. Make host directories owned by UID 1000 (the image's `node` user), then run:

```bash
docker run -d --name maya --restart unless-stopped \
  --stop-timeout 70 \
  --env-file .env \
  -v "$PWD/data:/app/data" \
  -v "$PWD/auth_info:/app/auth_info" \
  maya-assistant
```

Use `docker logs maya` to read startup output. For first pairing, run in the foreground so you can scan the QR. Do not run another Maya process against the mounted auth directory.

## Privacy and recovery

Maya sends selected group text and chosen media to Gemini for extraction. The SQLite database, any manual backups, and WhatsApp auth files contain private data. Keep host access limited to the owner; do not publish these files or set `LOG_LEVEL=debug` on a shared machine. The repository has a manual `npm run backup-db` command; automatic and off-host backups are deferred. A copy on the same disk does not help if the VM is lost. If the session is logged out, stop Maya, remove only the old auth folder after checking it is no longer used, and pair again.
