# NFC-IET CMS assignments

This optional integration reads the **Assignments** page in the owner's own NFC-IET CMS account. It turns the portal's assignment title, course, marks, deadline and status into Maya tasks. It does not read quiz answers, grades, messages, or other students' records.

## What it does today

- signs in only to the official `cms.nfciet.com` site with a fresh headless browser;
- reads the assignment list once per scheduled check;
- creates or updates Maya tasks from the portal's stable assignment ID;
- stops reminders when the portal says an assignment is submitted, under review, graded or expired;
- stores an append-only portal observation when a status or deadline changes, so Maya can explain what she last saw;
- records an item that disappears from a successful listing as *missing from the listing*, not submitted or completed.
- fails closed if the login flow, assignment-table shape, deadline format or status labels change.

The browser keeps no saved CMS cookies. It is closed at the end of every check. A failure does not delete tasks or make Maya guess.

## What it does not do yet

Maya does **not** upload or submit assignments in this version. A WhatsApp announcement can help identify an assignment, but it is never permission to submit anything. The future upload flow must show the owner the selected portal assignment and file, require a final private confirmation, then verify the portal receipt. It will be built only after an open, non-critical assignment form can be inspected with the owner.

## Store NFC credentials in OCI Vault

Do not put an NFC password in `.env`, GitHub, WhatsApp, a screenshot, or chat. On the Oracle VM:

1. In Oracle Cloud Console, create a **standard** Vault and a software-protected master encryption key. These fit the Always Free Vault allowance.
2. Create two secret values: one for the NFC CMS student ID and one for the NFC CMS password. Give them clear names such as `maya-nfc-student-id` and `maya-nfc-password`.
3. Create a dynamic group containing only Maya's VM instance, then add a policy that permits that dynamic group to read **only those two secret bundles**. Do not grant broad Vault administration or secret-management permissions.
4. Put only the two secret OCIDs in `/opt/maya-assistant/.env`:

   ```dotenv
   NFC_CMS_SYNC=true
   NFC_SYNC_CRON=0 7 * * *
   NFC_STUDENT_ID_SECRET_OCID=ocid1.vaultsecret...
   NFC_PASSWORD_SECRET_OCID=ocid1.vaultsecret...
   ```

5. Keep `/opt/maya-assistant/.env` owned by the Maya service account with mode `0600`, then restart: `sudo systemctl restart maya`.

The VM obtains its permission through its OCI instance principal. The secret values are fetched into memory for a single check and are never written to the database or logs. To rotate a password later, add a new secret version in OCI Vault; the next scheduled check reads the current version. No code deployment is needed.

## Control it privately

In Maya's private chat, say or send a voice note such as:

- `pause NFC deadline checking`
- `resume NFC checking`
- `pause VU and NFC deadline checking`

Maya asks for one explicit confirmation. Pausing stops new portal checks but preserves tasks already imported and their existing reminders.

## Verify safely

After enabling it, wait for the scheduled time or restart Maya and inspect the service log:

```bash
sudo journalctl -u maya -n 80 --no-pager
```

Then ask Maya privately for your tasks. Never test an upload with an important deadline until the future confirmation-and-receipt flow exists.
