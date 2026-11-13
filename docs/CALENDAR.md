# Google Calendar setup

Calendar sync is optional. Maya uses the Google Calendar API with an OAuth token for **one owner**. When `CALENDAR_SYNC=true`, dated Maya tasks become Google events. In separate mode, Maya also reads upcoming events from the selected Calendar once an hour and answers private questions from the next 30 days of events. The morning job and hourly checks remind the owner once on the day of each event whose title contains the word `important` (case-insensitive). Edits made directly in Google Calendar do not change Maya tasks. A timed Maya task event starts at the deadline and lasts 30 minutes; a date-only VU assignment becomes an all-day event.

1. In [Google Cloud Console](https://console.cloud.google.com/), enable **Google Calendar API** in your project. Configure the OAuth consent screen, then create an OAuth client with application type **Desktop app**. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the local `.env`. Never paste them into chat or commit them.
2. Stop local Maya if it uses the same WhatsApp session as your VM. Run `npm run calendar-auth` on your computer. Open the printed Google authorization URL on that same computer, approve access, and let the local callback finish. The helper uses the `calendar.events` scope, PKCE and a localhost callback; it saves the refresh token to the local `.env` with file mode `0600`.
3. Set `GOOGLE_CALENDAR_ID=primary` (or another calendar ID) and `CALENDAR_SYNC=true`. Copy the updated `.env` privately to the host running Maya, then restart its service. The VM setup is in [HOSTING.md](HOSTING.md). Keep only one Maya process connected to WhatsApp.

The token and client secret grant access to calendar events. Keep `.env` private and remove that grant in your [Google Account](https://myaccount.google.com/permissions) if the host or token is compromised. Failed outgoing event jobs remain queued; a failed incoming read leaves the last good event cache intact and retries later. The local tests use a fake API; enabling the feature requires your manual Google authorization and a live calendar check.

## Keep the authorization alive

Google refresh tokens issued to an external OAuth app in **Testing** expire after seven days when the app requests Calendar access. This is why a running Maya host can begin logging `invalid_grant` after about a week even though its `.env` values are correct. Google documents this Testing-mode limit in its [OAuth guide](https://developers.google.com/identity/protocols/oauth2#expiration).

Before publishing the OAuth app, deploy Maya's small public information site at `https://maya.codingmoves.com`. It provides the homepage, privacy policy, and terms pages that Google asks for. The exact Netlify, Cloudflare, Google Branding, and re-authorization steps are in [the Maya site deployment guide](MAYA-SITE-DEPLOYMENT.md).

Publishing removes the Testing-mode seven-day token limit, but a refresh token can still be revoked, invalidated, or expire after a long unused period. If Maya logs `invalid_grant`, run `npm run calendar-auth` again on your own computer after confirming the client ID and secret in local `.env`, then transfer the refreshed private `.env` to the host and restart Maya.
