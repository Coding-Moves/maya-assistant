# Saved memories and timetables

Maya stores facts you deliberately save in SQLite, separate from group messages, academic tasks, Calendar events, and VU imports. Only your verified private chat can change them. In separate mode, ordinary text and transcribed voice notes use the same path. Maya never sends memories to a group.

## Talk naturally

You do not need a command format. Examples to send Maya privately:

| You say or record | Maya does |
|---|---|
| “Remember permanently that I prefer short reminders.” | Saves a permanent preference. |
| “Keep my CS101 study plan for this semester; review it on 1 February 2027.” | Saves a semi-permanent memory with a review date. |
| “Remember until 15 December 2026 that I need to return the library book.” | Saves a temporary memory; it remains through its expiry and seven-day grace. |
| “What do you remember about my study preferences?” | Searches saved memory. |
| “Change my reminder preference to short messages.” | Updates one clearly matched memory; asks which one if several match. |
| “Change the review date for CS101 plan to 1 February 2027.” | Updates that memory's review date. |
| “Delete my reminder preference.” | Shows the exact target and asks you to reply “Yes, delete Reminder preference.” |
| “Show me my timetable.” | Shows the active timetable. |

If you ask Maya to remember something without saying how long, she asks whether it is permanent, for a semester/project with a review date, or until a date. You can answer briefly, by text or voice; she keeps your unfinished request for 15 minutes, including through a restart. She does not silently make an ambiguous fact permanent. A request for a timed notification is different from saving a memory: Maya will explain that this memory feature alone does not schedule a new WhatsApp alert. Academic deadlines still use the existing task reminder system.

The optional short controls are `/memory` for a summary and `/timetable` for the current classes. Developer controls use `/debug morning`, `/debug evening`, or `/debug weekly`; an unprefixed `debug` message cannot run a job. Existing everyday `help`, `tasks`, and `done <number>` continue to work.

## Retention and deletion

- **Permanent:** no automatic expiry; retained until you archive or delete it.
- **Semi-permanent:** a visible review/end date. The daily cleanup marks it for review and never silently deletes it.
- **Temporary:** an explicit due/expiry time, plus a seven-day grace after the latest due, expiry, or completion time. It never disappears just because seven days passed after creation.

Dates in conversation use `TIMEZONE` from `.env`; SQLite stores UTC ISO timestamps. Maya can list, search, show, update, replace, complete, or archive saved memories through natural requests. Target names must resolve to one record; she asks when several could match. Category clearing needs a named category and a preview. There is no “clear everything” operation.

Deletion needs a follow-up that names the target or category, such as “Yes, delete Reminder preference” or “Yes, clear notes.” The confirmation is bound to your verified chat, expires after 15 minutes, works once, and checks each target’s database revision again. A second deletion request replaces the earlier pending preview. Deletion cannot remove the database, WhatsApp session, `.env`, API keys, or backups. Audit metadata retains action, ID, and time without copying message contents.

## Timetable image or PDF

With `MEDIA_ENABLED=true`, send a supported image or PDF to Maya privately. A caption such as “My timetable” or “Please save this as my timetable” helps her recognize it. If you first ask by voice, she asks you to send the file. Maya reads at most `MEDIA_MAX_BYTES` (default 5 MB) and extracts up to 40 class rows: weekday, local time, subject, optional room/teacher, validity period where legible, and uncertainty notes. The original media bytes are not retained as a saved memory.

Review the preview. For a long timetable, ask “Show me the next page of the draft.” Correct a row naturally, for example “The second class ends at 11 AM.” Then reply “Yes, save the timetable” within 30 minutes. A missing day/start/end/subject or an end before start blocks confirmation. Unclear optional details remain marked as uncertain. A newer draft replaces an older unconfirmed draft; an active timetable stays intact until a valid new version is confirmed in one transaction. You can ask Maya to archive or delete a named timetable later; deletion still needs confirmation.

## Backup and limits

Before a deployment that changes the database schema, `npm run backup-db` makes a private online snapshot. The migration adds memory tables and preserves existing tasks/messages; it rejects a database written by a newer Maya build. The backup includes memories, timetable versions, and the full-text index. To restore, stop Maya, preserve the current database elsewhere, copy a verified backup to `DATABASE_PATH`, confirm its permissions, restart Maya, and inspect `/memory` and `/timetable`. Same-disk backups do not protect against VM disk loss.

Memory search uses SQLite FTS5 and may miss paraphrases or some Urdu/Roman Urdu variants. Gemini helps understand a natural request, but application code validates the result, resolves one target, and performs every write. Gemini cannot execute SQL, choose a WhatsApp recipient, or bypass confirmation. Only bounded relevant saved-memory results reach Gemini during private answers.
