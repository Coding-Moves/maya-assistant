# Import VU Classic To Do deadlines

Maya accepts **only quizzes and assignments** from the VU LMS *Classic To Do* page. This is a manual, credential-free import. Maya never requests or stores your student ID or LMS password, and never signs into or polls the portal. Bell notifications, notice-board stories, GDBs, fees and extracurricular notices are outside this import.

1. Sign in to the official VU LMS yourself and open **Activity Calendar → Classic To Do**. Read the **Assignments To Do** and **Quizzes To Do** tables. Copy only the course, title and due date/time you need into a local CSV file such as `data/vu-classic-todo.csv`.
2. Use this exact CSV header and ISO-style local dates. `source_id` is your stable identifier for the item; reuse it when a deadline changes. If left empty, Maya derives one from kind, course and title, so changing the title later can create a duplicate. A blank `due_time` is allowed for assignments whose page shows only a date. Quiz time is required. Do **not** guess a time.

   ```csv
   source_id,kind,course,title,due_date,due_time
   cs101-quiz-1,quiz,CS101,Quiz 1,2026-11-05,23:59
   cs101-assignment-1,assignment,CS101,Assignment 1,2026-11-06,
   ```

3. On the machine running Maya, run `npm run import-vu -- data/vu-classic-todo.csv` from the repo directory. The command prints created, updated and unchanged counts. Send `tasks` privately to Maya to check the result. Re-run the same file or an edited file when deadlines change. Missing rows do not cancel tasks, because a copied page might be incomplete; use `done <id>` for completed work.

Dates and times are interpreted in `TIMEZONE` (normally `Asia/Karachi`) and saved in UTC. For a date-only assignment, Maya keeps the exact time as *unspecified*: it shows the date without inventing a deadline time, sends day-based reminders, and creates an all-day Calendar event if sync is enabled. The internal 23:59 local anchor is only for ordering and reminder selection. The CSV is private student data; keep it under ignored `data/` and never commit it. This import does not update itself when VU changes; check Classic To Do and re-import as needed.
