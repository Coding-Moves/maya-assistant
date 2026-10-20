# Maya 🤖

**Your personal WhatsApp assistant that never misses a deadline.**

**Development status:** WhatsApp group ingest, AI task extraction, owner commands, and Q&A are implemented through Step 8. Scheduled reminders and weekly plans are planned for Step 9 in [ROADMAP.md](ROADMAP.md).

If you're in a busy WhatsApp group (a class, a course, a team, a community), you know the problem: the important stuff gets buried. A quiz date is posted at 11 PM, someone changes the room the next morning, and by Friday it's lost under 200 messages of "ok" and "thanks". You find out the deadline was yesterday.

Maya fixes that. She sits quietly in your WhatsApp, reads the groups you choose, picks out the things that matter, and reminds you before it's too late. You can also just ask her:

> **You:** @maya anything due this week?
> **Maya:** 🤖 Maya: You have 2 things coming up:
> 1. **MTH501 quiz**, Tuesday 9 AM (moved from Monday)
> 2. **CS101 assignment 3**, due Thursday 11:59 PM

---

## What Maya can do

- 👂 **Listens** only to the groups you pick. She never posts in them.
- 🧠 **Understands** messages with AI: quizzes, assignments, exams, room changes, cancelled classes. If a date changes, she updates it.
- ⏰ **Planned for Step 9:** morning and evening reminders, plus a weekly plan.
- 💬 **Answers questions** when you message her. If you don't call her name, she ignores you, so your notes stay notes.
- 🔒 **Runs on your own machine.** Messages and tasks are stored locally in SQLite; selected group text is sent to Gemini for analysis.
- 💸 **API costs depend on your Gemini plan and usage.** Check your model's pricing and set a budget alert before leaving Maya running.

## How it works, in plain words

1. Maya connects to WhatsApp as a **linked device**, the same way WhatsApp Web does.
2. New text messages and media captions in your chosen groups are saved on your computer.
3. Every few minutes, she sends the new messages to an AI (Google Gemini), which pulls out tasks and dates.
4. She answers **only you**, in your own chat. Scheduled reminders arrive in Step 9.

Want the technical details? See [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Before you start: please read this

**Maya uses an unofficial WhatsApp library.** WhatsApp doesn't offer an official way to read groups from a personal account, so Maya uses [Baileys](https://github.com/WhiskeySockets/Baileys), an open-source library that works like WhatsApp Web. This is against WhatsApp's Terms of Service, and accounts *can* get banned. Maya is built to be careful: she's read-only in groups, sends very few messages, and only to you. But the risk is never zero.

👉 **The safest setup is a second phone number** (a cheap SIM) just for Maya. You can start with your own number and switch later. It takes two minutes.

**Respect other people's privacy.** Messages from your group are sent to Google's AI to be understood. Only use Maya on groups where that's okay, and never share the database file.

**This is a personal tool,** not for spam, marketing, or bulk messaging.

---

## Quick start

You'll need **Node.js 22 or newer** (we develop on Node 24), a **Gemini API key** from [Google AI Studio](https://aistudio.google.com/), and your **phone** with WhatsApp.

```bash
git clone https://github.com/Muawiya-contact/maya-assistant.git
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

Copy the IDs of the groups you want into `GROUP_ALLOWLIST` in `.env` and restart with `npm run dev`. Maya saves new text and captions from those groups, extracts tasks every `EXTRACT_INTERVAL_MIN` minutes, and answers your commands and questions. Scheduled reminders arrive in Step 9.

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

**On a second number:** save it as "Maya" in your contacts and include her name or `@maya` in messages you want her to handle.

Don't like the name? Set `BOT_NAME` in `.env` to anything you want.

## Settings

Everything lives in `.env`. The main ones:

| Setting | What it does | Example |
|---|---|---|
| `BOT_NAME` | Her name, and the word that wakes her up | `Maya` |
| `BOT_MODE` | `self` = your own number, `separate` = second SIM | `self` |
| `GROUP_ALLOWLIST` | Which groups she reads | `1203...@g.us` |
| `TIMEZONE` | Your timezone for reminders | `Asia/Karachi` |
| `MORNING_DIGEST_CRON` | When to send "due today" | `0 8 * * *` |
| `EVENING_DIGEST_CRON` | When to send "due tomorrow" | `0 20 * * *` |
| `WEEKLY_PLAN_CRON` | When to send the weekly plan | `0 20 * * 5` |
| `GEMINI_MODEL` | Which AI model to use | `gemini-3.5-flash` |

The full list is in [`.env.example`](.env.example).

## Switching to a second number later

1. Add the new number to your groups.
2. In `.env`, set `BOT_MODE=separate` and `OWNER_JID=<your main number>@s.whatsapp.net`.
3. Delete the `auth_info/` folder.
4. Run `npm run dev` and scan the QR **with the new phone**.

In either mode, include Maya's name or `@maya` in messages you want her to handle. Messages without a trigger are ignored.

## What's coming

Maya is young. Next up: reading images and PDF announcements, syncing deadlines to Google Calendar, connecting to university LMS portals, and running 24/7 on a free server. See [ROADMAP.md](ROADMAP.md).

## Use it, fork it, make it yours

Maya is a personal project, shared openly. I'm **not accepting pull requests**, but you're free to fork it, change it, and run your own version. If you build with AI coding agents, point them to [AGENTS.md](AGENTS.md) and [ROADMAP.md](ROADMAP.md). They have everything needed to build it step by step.

## License

MIT. Use it, change it, share it.

---

*Built by a student who missed one deadline too many.*

## Coding Moves Lab

Maya is a public-source experiment in [Coding Moves Lab](https://codingmoves.netlify.app/lab/). The implemented group-ingest and task features are still in development; scheduled reminders remain planned.
