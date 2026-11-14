# Unified private assistant

This phase applies to `BOT_MODE=separate`. The owner still messages one WhatsApp chat. Groups remain read only, and `sendToOwner()` is the sole message-sending boundary. Self mode keeps its existing trigger and answer path.

## Request path

```text
verified owner message or transcribed voice
  → pending confirmation / memory / natural completion / simple command
  → bounded owner-tool loop when an authorized control action is requested
  → private question answer with selected context
  → sendToOwner()
```

The owner-tool loop still allows only registered tools, three model turns and six calls. It can read the next clear class from the confirmed timetable, then create a private reminder before it. It never gives Gemini shell, SQL, arbitrary URLs, credentials, or a recipient choice. A pending task clarification is bound to the configured owner JID and expires after ten minutes; a bare choice cannot confirm another kind of pending action. The owner may mark a recently expired task done by name, or any expired task by its exact `done <id>` command; expiry itself never asserts completion.

Maya also keeps at most three short private question-and-answer turns for 48 hours. When the owner replies to one of Maya's messages in WhatsApp, the matching earlier turn is selected first; otherwise recent dialogue helps with ordinary references such as “that one” or “the previous message.” This is a bounded convenience context, not permanent memory. It is never populated from group chats, and dialogue containing common credential labels is not retained.

## Owner media update drafts

An owner can send a supported image, PDF, text attachment, or voice note with a clear request such as “these deadlines are correct; update them all.” Maya extracts a small set of *proposed* academic task changes, resolves each by course and title, and saves an owner-bound preview for 15 minutes. It then lists additions, updates, cancellations, and unclear matches. A plain `yes` applies only the clear changes in that one preview; `no` discards it. An unclear item is never changed by a broad confirmation.

The draft is not a source of authority: media and its transcription remain untrusted data, and the model cannot choose a task ID or make a write directly. Before the single SQLite transaction, Maya checks that the relevant task state still matches the preview. Each applied owner-originated change is recorded with its WhatsApp source reference in `owner_task_update_events`; existing group-message provenance on the task is retained. Messages that ask for general settings or group monitoring continue through the already restricted owner-tool loop. WhatsApp cannot edit deployment secrets, `.env`, source code, shell commands, the session, or arbitrary database rows.

## Evidence selection

| Source | Selection | Trust and freshness |
|---|---|---|
| Joined groups | SQLite FTS5 keyword matches, then at most eight recent messages when a group activity question has no match | Only active groups with retrieval enabled. Each snippet has group, author, and sent time. If a group name matches several groups, Maya asks which one. |
| Academic tasks | Up to 14 relevant open or recently expired tasks; subject, type, title, precision and source are retained | A passed due time means `expired`, never `done`. VU tasks carry their source. |
| Saved memory | Up to six active search hits, or six active items for a list request | Owner-confirmed data; review state and update time remain visible. |
| Timetable | Active confirmed version; weekday filter where requested; up to 20 rows | Validity dates and an explicit stale flag are attached. Drafts are not used as facts. |
| Personal reminders | Up to six pending reminders only for reminder questions | Separate from academic tasks. |
| Google Calendar | Up to eight upcoming cached events only for Calendar questions | Last cache read time is attached. No claim of live lookup. |
| VU Classic To Do | Imported tasks plus last success/failure timestamps and configured cron | Maya states the configured schedule and whether the last check is known to have succeeded. |
| Owner dialogue | Last three short Q&A turns, at most 48 hours | Helps resolve “that group” or “it”; earlier model answers are not trusted as source facts. Questions containing common secret labels are not retained. |

Evidence is capped at 14,000 characters, with per-source record and text limits. FTS5 uses the existing SQLite database; there is no vector service or additional process. The message index is rebuilt once when an older database migrates. Existing group history is not deleted by this phase. Private dialogue and expired clarification rows are cleaned daily. Pending media jobs from groups Maya has left are discarded in bounded batches.

Group text, selected media descriptions, and chosen context snippets still go to Gemini. Auth files, environment variables, API keys and LMS password never enter the prompt. Content from groups, files, Calendar and LMS is data, not an instruction to use a tool. Owner-chat media descriptions continue to use the answer path without owner-control tools.

## Media and timetable behavior

| Input | Current path | Limit and fallback |
|---|---|---|
| Image and PDF | Gemini vision; timetable image/PDF can create a draft for owner review | Actual streamed bytes are capped by `MEDIA_MAX_BYTES`; group PDFs also have a 2 MB and 40-page guard. An invalid structured timetable result gets one bounded text-reading pass. No timetable becomes active without confirmation. |
| Voice note | Transcribe in the original language, then use the owner text path | Configured size limit; no permanent save without owner intent. |
| Short video | Gemini description/transcription | Configured size limit; group video over three minutes is skipped. |
| Text/CSV | Bounded UTF-8 content | Other document types are unsupported. |

Downloaded owner media bytes are not saved as a memory. Group media jobs hold WhatsApp metadata until processing, not the downloaded file bytes. The separate-number path checks the actual downloaded size and signatures for common JPEG, PNG, WebP, PDF, Ogg and MP4 formats before sending them to Gemini. Large or mismatched group files are skipped, while their captions can still be stored. If the structured timetable pass and its text fallback fail, Maya explains that no new timetable was saved. For a dense merged-cell schedule, a straight photo of each half is a practical fallback.

## Reliability and validation

- Owner requests run in arrival order with at most four queued/in-flight messages, so simultaneous media uploads cannot fan out across the 1 GB VM. Group media runs serially in batches of at most `MEDIA_BATCH_SIZE` (maximum three). Streamed downloads stop when actual bytes exceed the configured limit. Gemini text and JSON calls have a 20-second request timeout; media calls have 45 seconds. Transient API errors retain the existing bounded retries.
- Academic expiry runs at startup, during the extraction cycle and daily cleanup. Calendar jobs are queued by the existing task-status trigger, so an expired task's event is removed on the next Calendar sync. A later VU due-date change can reopen its source task; group extraction can match a recently expired task and reopen it only when the source message names the same course/title and supplies a clear future date. A crash between a send and its DB update can still duplicate a reminder.
- Run `npm run eval:phase3` for deterministic, no-API fixtures covering relevance, group-policy isolation, follow-up context, prompt size, natural completion, multi-step owner tools and timetable fallback. The context fixture prints evidence count, byte size and local RSS. Existing tests cover WhatsApp owner verification, unsupported media, retries and confirmation safety.
- Run `npm run eval:phase3:resources` before a production upgrade when a fresh resource measurement is needed. It creates a temporary SQLite database, loads 8 groups / 2,400 messages / 160 tasks, performs 100 targeted context lookups, prints peak RSS, largest context bytes and temporary DB size, then deletes the temporary directory. It makes no Gemini request and never opens Maya's real database. The script fails above 550 MB RSS or a 16,000-byte context, leaving headroom on the 1 GB VM.

On 2026-11-14, the committed fixture measured 158 MB peak RSS, a 5,337-byte largest context, and an 892,928-byte temporary database on the development host. The live Oracle service was separately observed active at about 279 MB RSS with 38 GB free disk; the production fixture should be re-run after this version deploys, because host measurements are not interchangeable.
- Before deploying a schema change, run `npm run backup-db` and keep the private snapshot. The migration is additive; it creates the message FTS index and backfills existing message text. Check `sudo systemctl status maya` and the service journal after deployment. The first index build may take longer on a large database.

## Verification limits

The committed tests use mocked Gemini responses and synthetic/redacted data. They do not prove how the current model will read the owner's dense timetable photo, or how a real voice note will be transcribed. A live Gemini test of the private exported image was not run because the execution approval rejected sending that image to the external API. The 1 GB Oracle VM's peak RSS and first FTS migration time need measurement after deployment; local fixture RSS is only a development signal. Automatic backup and off-host retention remain deferred by the owner.
