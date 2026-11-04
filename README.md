# Maya 🤖

**Your personal WhatsApp assistant that never misses a deadline.**

**Development status:** Core and Phases 2–5 are implemented. Media reading, Google Calendar, and daily VU Classic To Do checks require opt-in setup. Live VU login and import have been verified; the next unattended daily run still needs confirmation. The live Calendar check remains with the owner.

If you're in a busy WhatsApp group (a class, a course, a team, a community), you know the problem: the important stuff gets buried. A quiz date is posted at 11 PM, someone changes the room the next morning, and by Friday it's lost under 200 messages of "ok" and "thanks". You find out the deadline was yesterday.

Maya fixes that. On her own number, she quietly reads every group she has joined, keeps academic deadlines, and answers your private questions about the other groups. You can also just ask her:

> **You:** Anything due this week?
> **Maya:** Your MTH501 quiz is Tuesday at 9 AM, and CS101 assignment 3 is due Thursday at 11:59 PM. You've got this 🌿

---

## What Maya can do

- 👂 **Listens** to every group she has joined in separate mode; self mode still uses `GROUP_ALLOWLIST`. She never posts in groups.
- 🧠 **Understands** group messages with AI. In separate mode, only academic quizzes, assignments, and exams become reminder tasks. You can ask about other group activity privately. Optional media reading covers photos, voice notes, short video, PDFs, and text files within the size limit.
- ⏰ **Reminds you** about tasks due today and tomorrow, plus a weekly plan when Maya is running.
- 💬 **Answers questions** when you message her. In separate mode, every direct owner message gets a reply; self mode uses her name as a trigger.
- 👀 **Views only your WhatsApp Status** in separate mode and sends you a short private comment when she can read its text, caption, photo, or supported video. She does not store Status content or turn it into tasks, and ignores other people's Status updates. Photo and video comments send the media to Gemini and use the configured `MEDIA_MAX_BYTES` limit, independently of `MEDIA_ENABLED` (which controls group and direct owner media). Unsupported or oversized Status media without a caption is viewed without a comment.
- 📚 **Tracks VU Classic To Do deadlines** for quizzes and assignments through an optional daily portal check or a manual CSV import.
- 📅 **Connects to Google Calendar** when authorized: Maya creates events for her dated tasks, reads upcoming meetings, answers questions about them, and reminds you once on the day of events whose title contains `important`.
- 🔒 **Runs on your own machine.** Messages and tasks are stored locally in SQLite; joined group text is sent to Gemini for analysis in separate mode.
- 💸 **API costs depend on your Gemini plan and usage.** Check your model's pricing and set a budget alert before leaving Maya running.

## How it works, in plain words

1. Maya connects to WhatsApp as a **linked device**, the same way WhatsApp Web does.
2. New text messages and media captions in joined groups are saved locally in separate mode. When media reading is enabled, supported photos, audio, video, PDFs, and text files are sent to Gemini; their descriptions or transcripts are saved instead of the file. Direct owner media is handled privately and is not saved as a group message.
3. Every few minutes, she sends the new messages to an AI (Google Gemini), which pulls out tasks and dates.
4. She sends reminders and answers **only to you**, in your own chat.

Want the technical details? See [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Before you start: please read this

**Maya uses an unofficial WhatsApp library.** WhatsApp doesn't offer an official way to read groups from a personal account, so Maya uses [Baileys](https://github.com/WhiskeySockets/Baileys), an open-source library that works like WhatsApp Web. This is against WhatsApp's Terms of Service, and accounts *can* get banned. Maya is built to be careful: she's read-only in groups, sends very few messages, and only to you. But the risk is never zero.

👉 **The safest setup is a second phone number** (a cheap SIM) just for Maya. You can start with your own number and switch later. It takes two minutes.

**Respect other people's privacy.** In separate mode, messages from every group Maya joins, and supported media when enabled, are sent to Google's AI to be understood. Only add Maya where this is okay, and never share the database file.

**This is a personal tool,** not for spam, marketing, or bulk messaging.

---

## Quick start

You'll need **Node.js 22 or newer** (we develop on Node 24), a **Gemini API key** from [Google AI Studio](https://aistudio.google.com/), and your **phone** with WhatsApp.

```bash
git clone https://github.com/Coding-Moves/maya-assistant.git
cd maya-assistant
npm install
cp .env.example .env
```

Open `.env` and add your Gemini key. Then:

```bash
npm run dev
```

On the first run, a QR code appears. On your phone, open **WhatsApp → Settings → Linked devices → Link a device** and scan it. The saved session reconnects on later runs without a new QR code.

Stop `npm run dev` before listing your group IDs; both commands use the same WhatsApp session:

```bash
npm run list-groups
```

In separate mode, Maya reads every group she has joined; send her `groups` privately to see their names. In self mode, copy the IDs you want into `GROUP_ALLOWLIST` in `.env` and restart. Maya saves new messages, extracts tasks every `EXTRACT_INTERVAL_MIN` minutes, answers your commands and questions, and sends scheduled reminders while running.

To read media, set `MEDIA_ENABLED=true`. In separate mode, Maya supports images, WhatsApp voice notes, short videos, PDFs, and text/CSV files; self mode keeps image and PDF reading only. Maya handles at most `MEDIA_BATCH_SIZE` group files per extraction run and refuses files above `MEDIA_MAX_BYTES` (default 5 MB). Large group files with a caption still contribute that caption. Direct owner media gets a private size-limit reply. Other document types and large/long videos are not yet supported. Media reading uses Gemini and can increase API usage. A failed group item is retried three times, then quarantined and reported to you.

Google Calendar sync is optional. To enable it, follow [the Calendar setup guide](docs/CALENDAR.md). Dated open tasks become Calendar events; changing a task updates its event, and completing or cancelling it removes the event. In separate mode, Maya also reads the next 30 days of Calendar events hourly for private questions. The morning job and hourly checks remind you once about today's events with `important` in the title. Edits made in Google Calendar do not change Maya tasks.

VU students can enable an optional daily check of only the assignment and quiz tables in Classic To Do, or continue using the manual CSV importer. Follow [the VU setup guide](docs/VU-CLASSIC-TODO.md). The automatic check requires private LMS credentials and a Chromium browser on the host; Maya does not read bell, notice-board, or GDB items.

For an always-on host, see the [hosting guide](docs/HOSTING.md). It covers the current systemd setup and optional PM2 or Docker deployments with persistent private storage.

To save a consistent SQLite snapshot while Maya is running, use `npm run backup-db`. It keeps the newest seven completed snapshots in `data/backups/`. These backups contain private group messages and tasks, so keep them private. Backups on the same disk do not protect against loss of the machine; off-machine backup automation is deferred.

## Talking to Maya

**On your own number:** open the **"Message Yourself"** chat in WhatsApp. Start your message with her name, or mention `@maya` anywhere:

| You write | What happens |
|---|---|
| `@maya what's due tomorrow?` | She answers |
| `Hy @maya` | She greets you |
| `maya task` or `maya list` | Lists all open tasks |
| `maya tasks` | Lists all open tasks |
| `maya done 4` or `maya complete 4` | Marks task #4 as done |
| `maya help` or `maya ?` | Shows what she can do |
| `buy milk` | Ignored, it's your note |

**On a second number:** save it as "Maya" in your contacts and message her directly. You can write `done 4`, `hi`, or ask a question without using her name first. She replies in plain text, shows typing while answering with AI, and marks your message read when she starts replying. Messages from other people are ignored.

You can also say “I've done it” or “ho gaya”. If one open task or a task you just discussed clearly matches, Maya ticks it off. If several could match, she asks you which one by name.

Don't like the name? Set `BOT_NAME` in `.env` to anything you want.

## Settings

Everything lives in `.env`. The main ones:

| Setting | What it does | Example |
|---|---|---|
| `BOT_NAME` | Her name, and the word that wakes her up in self mode | `Maya` |
| `BOT_MODE` | `self` = your own number, `separate` = second SIM | `separate` |
| `OWNER_NAME` | Optional name Maya uses occasionally in separate mode | `Muawiya` |
| `GROUP_ALLOWLIST` | Self mode group IDs; separate mode reads all joined groups | `1203...@g.us` |
| `TIMEZONE` | Your timezone for reminders | `Asia/Karachi` |
| `MORNING_DIGEST_CRON` | When to send "due today" | `0 8 * * *` |
| `EVENING_DIGEST_CRON` | When to send "due tomorrow" | `0 20 * * *` |
| `WEEKLY_PLAN_CRON` | When to send the weekly plan | `0 20 * * 5` |
| `GEMINI_MODEL` | Which AI model to use | `gemini-3.5-flash` |
| `MEDIA_ENABLED` | Read supported group and direct owner media with Gemini | `false` |
| `CALENDAR_SYNC` | Sync dated tasks to Calendar and read upcoming events | `false` |

The full list is in [`.env.example`](.env.example).

## Switching to a second number later

1. Add the new number to your groups.
2. In `.env`, set `BOT_MODE=separate` and `OWNER_JID=<your main number>@s.whatsapp.net`.
3. Delete the `auth_info/` folder.
4. Run `npm run dev` and scan the QR **with the new phone**.

In self mode, include Maya's name or `@maya` in messages you want her to handle. On a separate number, direct messages from the owner need no trigger.

## What's coming

Maya is still experimental. See [ROADMAP.md](ROADMAP.md) for what is implemented and what still needs a manual live check.

## Use it, fork it, make it yours

Maya is a personal project, shared openly. I'm **not accepting pull requests**, but you're free to fork it, change it, and run your own version. If you build with AI coding agents, point them to [AGENTS.md](AGENTS.md) and [ROADMAP.md](ROADMAP.md). They have everything needed to build it step by step.

## License

MIT. Use it, change it, share it.

---

*Built by a student who missed one deadline too many.*

## Coding Moves Lab

Maya is a public-source experiment in [Coding Moves Lab](https://codingmoves.netlify.app/lab/). The one-day reminder check and optional integrations need the owner's live validation.
