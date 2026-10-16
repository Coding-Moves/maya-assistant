# AGENTS.md

Instructions for AI coding agents (Codex, Claude Code, Cursor, etc.) working on this repo.

## Read first
1. `ARCHITECTURE.md`: the design, file structure, DB schema, and AI contract. Follow it.
2. `ROADMAP.md`: the build steps. **Do only the step you are asked to do.** Don't build ahead.

## Hard rules (never break these)
- **Only `sendToOwner()` in `src/channels/whatsapp/send.ts` may call `sock.sendMessage`.** No other file sends messages.
- **Never send to groups or to anyone except the owner.** Groups are read-only.
- Every bot message starts with `🤖 ${BOT_NAME}: `. The router must ignore messages that start with this prefix.
- Never commit `.env`, `auth_info/`, `data/`, or any `*.db` file.
- Never log message text at `info` level or above. Use `debug`.
- Never hardcode a phone number, group ID, timezone, name, or API key. Everything comes from `src/config/env.ts`.

## Tech rules
- Node 22+ (develop on Node 24), ESM (`"type": "module"`), TypeScript strict, run with `tsx`.
- Baileys v7: use the `baileys` package pinned exactly to `7.0.0-rc14`. Check https://baileys.wiki before writing socket code; the API changes between versions.
  - Use the `connection.update` `qr` field + `qrcode-terminal`. Do not use `printQRInTerminal`.
  - JIDs may be LID (`@lid`) or PN (`@s.whatsapp.net`). Normalize with `jidNormalizedUser`, check both known forms for the owner, and resolve PN ↔ LID with Baileys' mapping store when needed. Normalization alone does not equate PN and LID. If the owner cannot be verified, ignore the message and do not send.
  - `markOnlineOnConnect: false`, `syncFullHistory: false`.
- Gemini via `@google/genai`; model from `GEMINI_MODEL`. Check the current SDK docs for the structured-output config. Validate all AI JSON with zod.
- Store times in UTC (ISO strings). Convert to `TIMEZONE` only for display and scheduling.
- Every `node-cron` job gets `{ timezone: config.TIMEZONE }`.
- Use DB transactions when applying multiple AI actions.

## Workflow
- Small, focused changes. Commit after each step with a clear message (e.g. `feat: step 5 router and ingest`).
- Do **not** run typecheck or lint after every step. Run `npm run typecheck && npm run lint` once at the end of each phase (the final step says when).
- If something in the docs is wrong or the library API changed, follow the real API, update the docs in the same commit, and mention it in your summary.
- If a step needs a human action (QR scan, API key, choosing groups), stop and say exactly what the human must do.
- **Do NOT open a PR** unless explicitly asked.

## End-of-step summary
Finish every step with:
1. What you built (files changed).
2. How to test it (exact commands or WhatsApp messages).
3. Any manual action needed.
4. Anything that differed from the docs.
