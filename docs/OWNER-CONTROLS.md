# Private owner controls

In `BOT_MODE=separate`, message Maya directly in ordinary English, Urdu, or Roman Urdu. A voice note you send to her is transcribed and follows the same route. Maya ignores control instructions embedded in images, PDFs, group messages, Calendar events, and LMS content. She never posts to a group. Self mode keeps its existing commands and behavior.

Examples:

- “Show my current settings.”
- “Set the media limit to 10 MB.”
- “Turn media reading off for Family group.”
- “Pause monitoring Family until Monday at 9 AM.”
- “Remind me to call Mum tomorrow at 6 PM.”
- “Show my upcoming reminders.”

Maya asks for a specific group, date, or reminder when it cannot safely resolve one. A sensitive change is only a proposal until you reply “yes” within 15 minutes; “no” cancels it. A confirmation is bound to your verified private chat, the exact action and target, and the state Maya previewed. It is single-use. If a memory or timetable confirmation is also waiting, name the action rather than sending a bare “yes”.

## Settings

`.env` is the deployment default. In separate mode, only these settings may have persisted SQLite overrides. Ask Maya to show settings or reset a named setting to its deployment default.

| Setting | Live range | Effect |
| --- | --- | --- |
| `MEDIA_ENABLED` | `true` or `false` | Group and direct owner media reading; owner Status handling remains separate. |
| `MEDIA_MAX_BYTES` | 1–10 decimal MB | Maximum direct owner, Status, and most group files. Group PDFs remain capped at 2 MB. |
| `MEDIA_BATCH_SIZE` | 1–3 | Maximum queued group files processed in one extraction run. |
| `EXTRACT_BATCH_SIZE` | 1–50 | Maximum queued messages sent in one extraction batch. |

Raising the media limit or switching media reading on or off needs confirmation. Every group-policy change also needs confirmation. A change takes effect on the next media or extraction operation. Existing in-flight reads keep the limit they started with. The scheduled extraction interval, cron expressions, reply-rate safety limit, model, bot/owner identity, database/auth paths, Gemini key, Google OAuth values, and VU credentials remain `.env`-only and require a restart when changed. No tool reads or edits arbitrary environment variables or secrets.

## Groups and large files

Every joined group stays visible by default. Its ingestion, media reading, academic task extraction, and private-answer retrieval can be changed separately. A pause holds new processing and retrieval until the specified time; it does not delete history. Turning ingestion off stops saving new messages. Turning media off prevents queued files from being read while disabled. Group names may change, so policies are keyed by group JID; ambiguous names are rejected.

Group files with a declared size over the effective limit are skipped before download. Unknown-size streams stop at the limit. Separate-mode group PDFs have a 2 MB cap. Book-like PDF filenames and group audio/video over three minutes are skipped; a simple PDF page-marker check also rejects obvious documents over 40 pages after a bounded download. These checks limit memory and Gemini usage, but a compressed PDF can hide its true page count. Captions can still be stored and analyzed when group ingestion and extraction are enabled.

Only academic quizzes, assignments, and exams create scheduled group-task reminders. Other group content stays available for private questions when retrieval is enabled.

## Personal reminders

An owner-created reminder has a title and an exact future time within one year. Maya checks due reminders once per minute and sends them only through `sendToOwner()`. You can list, change, or cancel an upcoming reminder; cancellation needs confirmation. A failed send stays pending. A crash after a successful send but before SQLite records it may cause a rare duplicate. Personal reminders are separate from academic tasks and are not synced to Google Calendar.

## How the agent is contained

`src/features/owner-agent.ts` runs at most three model turns and six function calls for one request, serially, with a 45-second deadline. `src/features/owner-tools.ts` defines each tool's strict Zod input, typed result, owner permission, risk, target, confirmation rule, and synchronous handler. Gemini sees descriptions and proposes calls; it never executes code itself. Application code rejects unknown calls, invalid arguments, non-owner input, ambiguous group names, stale confirmations, and repeated write calls. Completed steps are reported even if a later step fails.

`src/config/runtime.ts` is the allowlisted settings service; `src/db/repos/group-policies.ts` applies group rules at ingestion and in the queued-message/media and retrieval queries. `owner_agent_requests` and `owner_action_audit` prevent duplicate writes on WhatsApp redelivery and record action metadata without secrets. To add a tool, define a bounded schema and result, specify its owner scope, target, risk, confirmation and revision rules, then add deterministic tests for invalid input, replay, and a partial failure. Do not add arbitrary SQL, shell, filesystem, recipient, secret, or URL tools.

Before deploying the schema migration to a host with real data, run `npm run backup-db` there and keep the snapshot private. The app upgrades SQLite to `user_version=2` on startup. A branch push alone does not update the running VM; deployment follows a merged main build and the host's deployment workflow.
