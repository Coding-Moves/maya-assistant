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

## Updating secrets on the Oracle VM

Maya currently reads `/opt/maya-assistant/.env` at startup. From your authorized laptop, connect with `ssh -i ~/.ssh/id_ed25519 ubuntu@<VM_PUBLIC_IP>`, then use `sudoedit /opt/maya-assistant/.env` on the VM. Restore ownership and permissions with `sudo chown maya:maya /opt/maya-assistant/.env` and `sudo chmod 600 /opt/maya-assistant/.env`; restart with `sudo systemctl restart maya`. Check `sudo systemctl status maya` and `sudo journalctl -u maya -n 30 --no-pager` for configuration errors. The values are listed in [`.env.example`](../.env.example): the Gemini key and (if enabled) Google OAuth client secret and refresh token are sensitive; owner JID, groups and schedules are configuration. WhatsApp `auth_info/` and SQLite `data/` stay on persistent private disk, not in Vault. Do not paste keys into chat, commit `.env`, or copy it to a public location. VU imports require no LMS password.

If you want to edit secrets in the **Oracle Cloud Console**, OCI Vault is the future path: create a standard virtual vault and a software-protected key, store each key as a secret, then give the VM a narrowly scoped instance principal permission to read only those secrets. Add a VM startup retrieval step to put current values into Maya's private environment and restart Maya after changing a secret version in the Console. This repository does **not** yet fetch Vault secrets; changing a Vault value alone will not change the running service. Check [Oracle's Always Free Vault limits](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) and [secret version instructions](https://docs.oracle.com/en-us/iaas/Content/secret-management/Tasks/create-secret-version.htm) before setting it up. Avoid a private vault, which is outside Always Free.
