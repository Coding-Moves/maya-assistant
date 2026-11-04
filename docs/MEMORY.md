# Saved memories and timetables

Maya stores facts you deliberately save in SQLite, separate from group messages, academic tasks, Calendar events, and VU imports. Only the verified owner chat can use these commands. Maya never sends a memory to a group. In separate mode, no `Maya` trigger is needed; in self mode, use the normal trigger before the commands.

## Save and find

Send these as private WhatsApp messages:

| Command | Example | Retention |
|---|---|---|
| `memory save permanent <category> \| <title> \| <text>` | `memory save permanent preference \| Reminder tone \| Keep it short` | Until you delete it |
| `memory save semi <YYYY-MM-DD> <category> \| <title> \| <text>` | `memory save semi 2027-02-01 semester \| CS101 plan \| Study on Fridays` | Marked for review on that local date; never automatically deleted |
| `memory save temporary <YYYY-MM-DD> <category> \| <title> \| <text>` | `memory save temporary 2027-01-15 note \| Library book \| Return the book` | Expires at the end of that local day, then kept for seven days |
| `memory list` / `memory list permanent` / `memory list category <name>` | `memory list category preference` | Shows ID, lifecycle, status and date |
| `memory show <id>` / `memory search <words>` | `memory search library book` | Exact ID or local full-text search |
| `memory status` | `memory status` | Counts by lifecycle, including review-due records |

Dates use `TIMEZONE` from `.env`; Maya stores UTC timestamps. For a temporary memory with a due date, the seven-day grace starts no earlier than its due date, even if it was created or completed much earlier. Group quiz/assignment deadlines continue to use the existing **tasks** table and reminder jobs; saving a temporary memory does not schedule a new WhatsApp reminder. If a note needs no clear end date, choose permanent or semi-permanent, or provide a temporary expiry date rather than guessing.

## Change or remove

- `memory update <id> <new text>` changes the body.
- `memory replace <id> <new title> | <new text>` replaces title and body under the same ID.
- `memory date <id> review|expiry|due <YYYY-MM-DD>` changes the retention/due date where that lifecycle allows it.
- `memory complete <id>` marks an active temporary memory complete.
- `memory archive <id>` hides it from normal search but keeps it available by ID.
- `memory delete <id>` requests deletion of one memory.
- `memory clear category <name>` requests deletion of up to 100 memories in one named category. There is no `clear everything` command.

For deletion or category clearing, Maya sends a `memory confirm <code>` instruction. The code expires after 15 minutes, is tied to the verified owner chat, works once, and checks each target's revision again before deleting it. Confirming a deletion cannot remove the database, WhatsApp session, `.env`, API keys, or backups. Deletion also removes a timetable's structured versions; audit metadata retains only action, ID, and time.

## Timetable image or PDF

In separate mode with `MEDIA_ENABLED=true`, send a supported image or PDF to Maya privately with the caption `save timetable` or `update timetable`. Maya reads up to `MEDIA_MAX_BYTES` (default 5 MB) and extracts at most 40 class rows. She keeps a typed draft with days, local times, subject, location/teacher where legible, validity dates if present, and uncertainty notes. The original media bytes are not retained as a saved memory. An image/PDF that looks like a timetable without a save caption may also produce a draft; it is never activated automatically.

Review the preview carefully. For a long draft, use `timetable draft <code> 2` (then page 3, etc.) to see all rows. Use `timetable correct <code> <row number> <field> <value>` to fix a row; fields are `day_of_week` (Monday=1 through Sunday=7), `start_local`, `end_local` (24-hour `HH:mm`), `subject`, `location`, or `teacher`. Then send `timetable confirm <code>` within 30 minutes. Missing day/start/end/subject or an end before start blocks confirmation. Unclear optional details remain marked as uncertain until you verify them.

`timetable show` displays the active version (add a page number for longer schedules). `timetable archive <memory ID>` archives it; `timetable delete <memory ID>` asks for deletion confirmation. On replacement, Maya keeps the old active version until the new draft passes validation and your confirmation; the previous version is then archived inside the same database transaction. If extraction fails or the draft expires, the active timetable stays intact. The most recent confirmed media message ID is retained as provenance, not its raw bytes.

## Backup and recovery

Before a deployment that changes the database schema, run `npm run backup-db` and keep the resulting private file. The migration adds memory tables and preserves existing tasks/messages; it rejects a database written by a newer Maya build. The existing backup command includes memories, timetable versions, and the full-text index. For restoration, stop Maya, preserve the current database elsewhere, copy a verified backup to `DATABASE_PATH`, confirm its file permissions, then restart Maya and inspect `memory status` and `timetable show`. Same-disk backups do not protect against VM disk loss.

The memory full-text index uses SQLite FTS5. It is for retrieval convenience; the structured SQLite rows remain the source of truth. Search is keyword-oriented and may miss paraphrases or some Urdu/Roman Urdu variants. Maya sends only relevant, bounded saved-memory results to Gemini when answering questions. The model cannot execute SQL or choose a WhatsApp recipient.
