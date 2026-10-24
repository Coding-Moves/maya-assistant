# Roadmap & Build Guide

This file has two parts: the **roadmap** (what we're building), and the **build guide**, which gives a step-by-step prompt for each step to paste into your coding agent (Codex, Claude Code, etc.).

Steps marked 🙋 **Manual** are things a human has to do: scan a QR code, copy an ID, or create a key.

---

## Roadmap

| Phase | What | Status |
|---|---|---|
| **1. Core** | WhatsApp listener, task extraction, reminders, Q&A, self-chat mode | 🚧 In progress |
| **2. Always on** | Second-number mode, run 24/7 (pm2 / Docker / free VM), DB backups | ⏳ |
| **3. Media** | Read images and PDF announcements with Gemini vision | ⏳ |
| **4. Calendar** | Sync tasks with due dates to Google Calendar | ⏳ |
| **5. More sources** | Source plugin interface; first plugin: a university LMS | ⏳ |
| **6. Extras** | MCP server over the DB, multi-language support (e.g. Roman Urdu), simple web dashboard | 💡 Ideas |

---

## How to use this guide

- Do the steps **in order**. Each step builds on the one before it.
- Paste the **Prompt** into your agent. The agent reads `AGENTS.md` automatically, and the prompt also tells it to.
- **Commit after each step.** Don't stop to typecheck or lint after every step. Run `npm run typecheck && npm run lint` **once at the end of each phase** and fix everything together.
- When a step says 🙋 **Manual**, do that part yourself before moving on.

---

## Phase 1 — Core

### Step 0 — Prep 🙋 Manual
- [ ] Install Node.js 22 or newer (`node -v` to check); use Node 24 for development.
- [ ] Get a **Gemini API key** from Google AI Studio. If it's a paid key, set a **budget alert** in Google Cloud.
- [ ] Make sure the repo has `README.md`, `ARCHITECTURE.md`, `ROADMAP.md`, `AGENTS.md`, `.env.example`.
- [ ] Have your phone ready (you'll scan a QR in Step 3).

---

### Step 1 — Project scaffold

**Goal:** an empty project that runs, with config and logging in place.

**Prompt:**
```
Read AGENTS.md, ARCHITECTURE.md and ROADMAP.md first.

Do Step 1 (Project scaffold) only.
- Create package.json (type: module, engines node >=22), tsconfig.json (strict, NodeNext), eslint.config.js + prettier, .gitignore (node_modules, data/, auth_info/, .env, *.db*), LICENSE (MIT).
- Scripts: dev (tsx watch src/index.ts), start (tsx src/index.ts), list-groups, backup-db, typecheck (tsc --noEmit), lint.
- Install exact versions (no version ranges): `baileys@7.0.0-rc14`, @google/genai, better-sqlite3 13.x, node-cron, zod, pino 9.x, qrcode-terminal, dotenv; dev: typescript 6.0.3, tsx, @types/node (Node 22 types), @types/better-sqlite3, @types/qrcode-terminal, eslint, @eslint/js, prettier, typescript-eslint.
- src/config/env.ts: load .env, validate every variable in .env.example with zod, export a typed config. Fail fast with a clear message.
- src/utils/logger.ts (pino), src/utils/time.ts (timezone helpers).
- src/index.ts: load config, log "Maya starting", nothing else yet.
Do not build anything from later steps. Commit when done. Do NOT open a PR.
```

**Done when:** `npm run dev` prints "Maya starting", and a missing `GEMINI_API_KEY` shows a clear error.

---

### Step 2 — Database

**Goal:** SQLite with the tables and helper functions.

**Prompt:**
```
Read AGENTS.md and ARCHITECTURE.md. Do Step 2 (Database) only.
- src/db/client.ts: better-sqlite3 at DATABASE_PATH, create the folder if missing, WAL mode, foreign keys on.
- src/db/schema.sql exactly as in ARCHITECTURE.md; src/db/migrate.ts applies it on start.
- src/db/repos/messages.ts: insertMessage (ignore duplicates via UNIQUE), getUnprocessed(limit), incrementExtractAttempts(ids), quarantineFailedBatch(ids), pendingFailureBatches(), markFailureBatchNotified(id), markProcessed(ids), recentMessages(chatIds, limit).
- src/db/repos/tasks.ts: createTask, updateTask, cancelTask (including `last_msg_id`), markDone, openTasks, tasksDueBetween(startUtc, endUtc), markReminded(id, 'morning'|'evening', expectedDueAt).
- Store times as ISO UTC strings.
- Call migrate from src/index.ts.
Commit when done. Do NOT open a PR.
```

**Done when:** running the app creates `data/maya.db` with both tables.

---

### Step 3 — WhatsApp connection

**Goal:** connect to WhatsApp, show a QR, stay connected.

**Prompt:**
```
Read AGENTS.md and ARCHITECTURE.md. Before coding, check the current Baileys v7 docs (https://baileys.wiki) for makeWASocket options, useMultiFileAuthState, the connection.update event and DisconnectReason. Do Step 3 (WhatsApp connection) only.
- src/channels/whatsapp/connection.ts: useMultiFileAuthState(AUTH_DIR), makeWASocket with markOnlineOnConnect:false, syncFullHistory:false, pino logger at warn level. Render the qr from connection.update with qrcode-terminal (do NOT use printQRInTerminal). Save creds on creds.update.
- Reconnect on close with exponential backoff (1s → max 5min). A disconnect with `DisconnectReason.restartRequired` after scanning is expected; reconnect with the saved credentials. If logged out, log a clear message telling the user to delete AUTH_DIR and rescan, then exit.
- src/channels/whatsapp/identity.ts: after connection opens, store the owner identity. In self mode: sock.user.id and sock.user.lid, normalized. In separate mode: OWNER_JID (and its LID if resolvable via `sock.signalRepository.lidMapping.getLIDForPN`). Export isOwnerChat(jid, alternateJid?) and fail closed when the identity cannot be verified.
- Log "Connected as <name>" when open.
Commit when done. Do NOT open a PR.
```

🙋 **Manual:** run `npm run dev`, then scan the QR with **WhatsApp → Linked devices → Link a device**. Restart the app and check that it reconnects **without** a new QR.

**Done when:** the app connects, and restarts reuse the saved session.

---

### Step 4 — List groups script

**Goal:** a helper script to find group IDs.

**Prompt:**
```
Read AGENTS.md. Do Step 4 only.
- scripts/list-groups.ts: reuse the connection module, call sock.groupFetchAllParticipating(), print a table of group name + JID (and community/announcement flag if available), then exit cleanly.
Commit when done. Do NOT open a PR.
```

🙋 **Manual:** stop the running app before using the same auth directory with `npm run list-groups`. Copy the IDs of the groups you want into `GROUP_ALLOWLIST` in `.env` (comma-separated).

---

### Step 5 — Router and ingest

**Goal:** save messages from allowlisted groups and ignore everything else.

**Prompt:**
```
Read AGENTS.md and ARCHITECTURE.md. Do Step 5 only.
- src/channels/whatsapp/parse.ts: extract text from conversation, extendedTextMessage.text, imageMessage.caption, documentMessage.caption, videoMessage.caption. Unwrap ephemeral/viewOnce wrappers. Return null if no text.
- src/channels/whatsapp/router.ts: on messages.upsert (type 'notify' only):
  - group JID in GROUP_ALLOWLIST → features/ingest.ts
  - isOwnerChat(jid) → (placeholder, handled in Step 6)
  - everything else → ignore
  - Ignore any message whose text starts with the bot prefix "🤖 <BOT_NAME>:".
- src/features/ingest.ts: save to messages (source 'whatsapp', external_id = key.id, chat_id = allowlisted group JID, chat_name from group metadata cache, sent_at from messageTimestamp in UTC). Deduplicate by source + chat_id + external_id.
- Log at debug level only (no message text at info).
Commit when done. Do NOT open a PR.
```

🙋 **Manual:** post a test message in an allowlisted group (or wait for one), and check that it shows up in the DB.

---

### Step 6 — Sending, trigger word, and simple commands

**Goal:** Maya replies to you, and only you.

**Prompt:**
```
Read AGENTS.md and ARCHITECTURE.md. Do Step 6 only.
- src/channels/whatsapp/send.ts: sendToOwner(text). It is the ONLY place that calls sock.sendMessage. Always prefix "🤖 <BOT_NAME>: ". Send only to the owner chat JID. Rate limit to MAX_REPLIES_PER_HOUR; drop and log if exceeded.
- Trigger: in self mode a message counts only if it is fromMe and in the owner chat, and it needs the bot name at the start (case-insensitive, optional "@", followed by space/comma/colon/end) or "@<BOT_NAME>" as a whole word anywhere. Strip the trigger before handling. In separate mode, handle any inbound text from the verified owner; a trigger is optional and may be stripped. Ignore Maya's own outgoing messages using `key.fromMe`.
- src/features/commands.ts (no AI): "help"/"?", "task"/"tasks"/"list" (open tasks with id, subject, title, due in TIMEZONE), "done <id>"/"complete <id>". Unknown text → pass to ask (stub that replies "coming in Step 8" for now).
Commit when done. Do NOT open a PR.
```

🙋 **Manual:** in "Message Yourself", send `maya help`, then `buy milk`. The first should get a reply, the second should be ignored.

---

### Step 7 — AI client and task extraction

**Goal:** turn group messages into tasks automatically.

**Prompt:**
```
Read AGENTS.md and the "AI extraction contract" in ARCHITECTURE.md. Check the current @google/genai docs for structured JSON output before coding. Do Step 7 only.
- src/ai/gemini.ts: client with GEMINI_API_KEY and GEMINI_MODEL; generateJson(prompt, zodSchema) and generateText(prompt) via `ai.models.generateContent({ model, contents, config })`. For structured JSON, use `config.responseMimeType: 'application/json'` with `config.responseJsonSchema` (a supported JSON Schema converted from zod), parse `response.text`, then validate with zod. Retry transient `ApiError.status === 429` or 5xx with exponential backoff and jitter (max 3); do not retry permanent auth/config errors.
- src/ai/schemas.ts: zod schema for { actions: [...] } exactly as in ARCHITECTURE.md, including `source_msg_ref` on every action.
- src/ai/prompts.ts: extraction prompt. Include current time, TIMEZONE, open tasks, and the message batch. Rules: resolve relative dates from each message's own time; no date → null, never guess; ignore chatter; prefer update/cancel over creating duplicates. Output due_at in UTC.
- src/features/extract.ts: take up to EXTRACT_BATCH_SIZE unprocessed messages, call AI, validate every action and its referenced message/task IDs, apply actions in one DB transaction, mark messages processed. On validation/extraction failure: keep messages pending and increment each message's `extract_attempts`; after 3 failures quarantine them (`processed = -1`) in one failure batch. Notify the owner once per failed batch via `sendToOwner()` (batch ID and message IDs, no message text); record successful notification and retry pending ones.
- Run it every EXTRACT_INTERVAL_MIN minutes (simple interval for now; Step 9 moves it to the scheduler). Skip if no unprocessed messages (no API call).
Commit when done. Do NOT open a PR.
```

🙋 **Manual:** post (or wait for) a message like "Quiz 2 on Monday 10am, lectures 1-5". After the interval, `maya tasks` should list it.

---

### Step 8 — Ask Maya anything

**Goal:** answer free-form questions.

**Prompt:**
```
Read AGENTS.md. Do Step 8 only.
- src/features/ask.ts: build context = open tasks + tasks due in the next 14 days + the last ASK_CONTEXT_MESSAGES group messages; current time and TIMEZONE. Include a short "About you" section with the bot name, current abilities, planned reminders, commands, and visibility limits. Ask the AI to answer short and clear in the user's language, greet naturally, and say it doesn't know when a task or deadline lacks supporting data.
- Replace the Step 6 stub with this.
- Send "🤖 <BOT_NAME>: thinking..." only if the answer takes more than 3 seconds.
Commit when done. Do NOT open a PR.
```

🙋 **Manual:** ask `@maya what's due this week?`

---

### Step 9 — Scheduler: reminders and weekly plan

**Goal:** reminders arrive on time without being asked.

**Prompt:**
```
Read AGENTS.md. Do Step 9 only.
- src/scheduler/jobs.ts: register digest and weekly jobs with node-cron, ALWAYS with { timezone: TIMEZONE }. Move the extraction interval from Step 7 into this scheduler without converting it to a cron expression (an arbitrary interval does not map to `*/N` across hour boundaries):
  - extraction every EXTRACT_INTERVAL_MIN via an interval, with overlapping runs prevented
  - MORNING_DIGEST_CRON → features/digests.ts: open tasks due today (in TIMEZONE) not yet morning-reminded; send one message; mark reminded only after successful send, passing the selected due date to `markReminded`.
  - EVENING_DIGEST_CRON → tasks due tomorrow not yet evening-reminded; send; mark reminded only after successful send, passing the selected due date to `markReminded`.
  - WEEKLY_PLAN_CRON → features/weeklyPlan.ts: AI-written plan for the next 7 days from open tasks, ordered by urgency.
  - If there is nothing to send, send nothing.
- Add a hidden command "debug run <morning|evening|weekly>" (owner only) to trigger jobs manually for testing.
Commit when done. Do NOT open a PR.
```

🙋 **Manual:** test with `maya debug run morning`.

---

### Step 10 — Hardening

**Goal:** stable enough to leave running.

**Prompt:**
```
Read AGENTS.md. Do Step 10 only.
- Graceful shutdown on SIGINT/SIGTERM: stop cron jobs, close socket, close DB.
- Global handlers for unhandledRejection/uncaughtException that log and shut down cleanly; do not continue after an uncaught exception.
- scripts/backup-db.ts: `await` better-sqlite3 `backup()` to data/backups/maya-<timestamp>.db, keep the last 7 completed backups.
- Make sure no message text is logged at info level anywhere.
- Update README/ARCHITECTURE only if behavior differs from what they describe.
Then run npm run typecheck and npm run lint ONCE and fix all issues. Commit. Do NOT open a PR.
```

🙋 **Manual:** leave Maya running for a day and check the morning and evening reminders arrive. 🎉 **Phase 1 done.**

---

## Phase 2 — Always on (outline)

1. **Second number:** test `BOT_MODE=separate` end-to-end (owner match by PN and LID).
2. **Process manager:** add a `pm2` ecosystem file and a `Dockerfile` with volumes for `data/` and `auth_info/`.
3. **Hosting guide:** document running on an old laptop, an old Android phone (Termux), or a free cloud VM. Hosts with a **persistent disk** are required, because SQLite and the session must survive restarts.
4. **Daily DB backup** cron job.
5. **Auth storage and privacy review:** reassess `useMultiFileAuthState` for long-running hosting and review the handling, retention, and Gemini transmission of group messages.

## Phase 3 — Media (outline)
Download image and PDF announcements (allowlisted groups only, with a size limit), send them to Gemini vision, and save the extracted text as a message, so the normal extraction picks it up.

## Phase 4 — Google Calendar (outline)
OAuth for a single user, plus a `calendar_event_id` column on tasks. Create, update, and delete events when tasks change. Add `CALENDAR_SYNC=true` to enable it.

## Phase 5 — More sources (outline)
Define a `Source` interface (`start()`, which emits normalized messages or tasks). Move WhatsApp behind it. First new plugin: an LMS (each university is different, so plugins live in `src/sources/<name>`).

## Phase 6 — Ideas
- MCP server (read-only) so AI assistants can ask "what's due?"
- Roman Urdu / Hindi / other language prompts
- A small web dashboard
