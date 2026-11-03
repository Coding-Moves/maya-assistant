# VU Classic To Do deadlines

Maya accepts **only quizzes and assignments** from the VU LMS *Classic To Do* page. Bell notifications, notice-board stories, GDBs, fees, and extracurricular items are outside this feature.

## Optional daily check on your private VM

Install the exact dependencies with `npm ci`, then install Playwright's system libraries and browser on the VM:

```bash
sudo /opt/maya-assistant/node_modules/.bin/playwright install-deps chromium
sudo -u maya -H /opt/maya-assistant/node_modules/.bin/playwright install chromium
```

In the private `/opt/maya-assistant/.env`, set `VU_LMS_SYNC=true`, `VU_STUDENT_ID`, and `VU_PASSWORD`; keep that file readable only by Maya's service account. Do not put credentials in chat or Git. `VU_SYNC_CRON=0 6 * * *` checks at 6 AM in `TIMEZONE`; change the cron expression if needed. Restart `maya.service` after changing the file.

If the password contains `#`, quote the whole value, for example `VU_PASSWORD="your#password"`. An unquoted `#` starts a dotenv comment and silently shortens the password Maya uses.

Run `npm run sync-vu` on the VM once to check sign-in and import immediately, then send `tasks` privately to Maya. The daily job runs silently when successful and sends a private warning if it fails. Maya signs in through a normal browser and reads only the Assignments To Do and Quizzes To Do tables. She does not bypass CAPTCHA or other verification; if VU requires it or changes the page layout, the check fails without changing tasks. Review VU's current rules before enabling automated access. Change the private `.env` password whenever your LMS password changes.

The browser session is discarded after each run. The ID and password stay in the VM's private `.env`; no cookies are saved. Missing rows never cancel tasks because a page may be incomplete. A changed title can create a second task because the stable key is type, course, and title.

## Manual CSV alternative

This route does not need LMS credentials or Chromium.

1. Sign in to the official VU LMS yourself and open **Activity Calendar → Classic To Do**. Read the **Assignments To Do** and **Quizzes To Do** tables. Copy only the course, title and due date/time you need into a local CSV file such as `data/vu-classic-todo.csv`.
2. Use this exact CSV header and ISO-style local dates. `source_id` is your stable identifier for the item; reuse it when a deadline changes. If left empty, Maya derives one from kind, course and title, so changing the title later can create a duplicate. A blank `due_time` is allowed for assignments whose page shows only a date. Quiz time is required. Do **not** guess a time.

   ```csv
   source_id,kind,course,title,due_date,due_time
   cs101-quiz-1,quiz,CS101,Quiz 1,2026-11-05,23:59
   cs101-assignment-1,assignment,CS101,Assignment 1,2026-11-06,
   ```

3. On the machine running Maya, run `npm run import-vu -- data/vu-classic-todo.csv` from the repo directory. The command prints created, updated and unchanged counts. Send `tasks` privately to Maya to check the result. Re-run the same file or an edited file when deadlines change. Missing rows do not cancel tasks, because a copied page might be incomplete; use `done <id>` for completed work.

Dates and times are interpreted in `TIMEZONE` (normally `Asia/Karachi`) and saved in UTC. For a date-only assignment, Maya keeps the exact time as *unspecified*: it shows the date without inventing a deadline time, sends day-based reminders, and creates an all-day Calendar event if sync is enabled. The internal 23:59 local anchor is only for ordering and reminder selection. The CSV is private student data; keep it under ignored `data/` and never commit it. Manual imports do not update themselves when VU changes.
