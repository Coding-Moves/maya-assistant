# Google Calendar setup

Calendar sync is optional and belongs to one owner. When `CALENDAR_SYNC=true`, Maya puts dated tasks into Google Calendar. In separate mode, she also looks at upcoming events once an hour, answers private Calendar questions from the next 30 days, and reminds the owner on the day of an event whose title contains `important`. Changing an event directly in Google Calendar does not change Maya's task. A timed task becomes a 30-minute event; a date-only VU assignment becomes an all-day event.

1. In [Google Cloud Console](https://console.cloud.google.com/), enable **Google Calendar API** in your project. Configure the OAuth consent screen, then create an OAuth client with application type **Desktop app**. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the local `.env`. Never paste them into chat or commit them.
2. Stop local Maya if it uses the same WhatsApp session as your VM. Run `npm run calendar-auth` on your computer. Open the printed Google authorization URL on that same computer, approve access, and let the local callback finish. The helper uses the `calendar.events` scope, PKCE and a localhost callback; it saves the refresh token to the local `.env` with file mode `0600`.
3. Set `GOOGLE_CALENDAR_ID=primary` (or another calendar ID) and `CALENDAR_SYNC=true`. Copy the updated `.env` privately to the host running Maya, then restart its service. The VM setup is in [HOSTING.md](HOSTING.md). Keep only one Maya process connected to WhatsApp.

The token and client secret can access Calendar events, so keep `.env` private. If the host or token is compromised, remove Maya's access from your [Google Account](https://myaccount.google.com/permissions). If Maya cannot send an event, she keeps that job queued. If she cannot read Calendar, she keeps the last good local cache and tries again later. Tests use a fake API, so you still need to approve Google access and check the live Calendar connection yourself.

## Keep the authorization alive

Google expires Calendar refresh tokens after seven days while an external OAuth app is in **Testing**. That is why a running Maya host can start logging `invalid_grant` after about a week even when `.env` is correct. Google explains that Testing-mode limit in its [OAuth guide](https://developers.google.com/identity/protocols/oauth2#expiration).

Before publishing the OAuth app, deploy Maya's small public information site at `https://maya.codingmoves.com`. It provides the homepage, privacy policy, and terms pages that Google asks for. The exact Netlify, Cloudflare, Google Branding, and re-authorization steps are in [the Maya site deployment guide](MAYA-SITE-DEPLOYMENT.md).

Publishing removes the Testing-mode seven-day token limit, but a refresh token can still be revoked, invalidated, or expire after a long unused period. If Maya logs `invalid_grant`, run `npm run calendar-auth` again on your own computer after confirming the client ID and secret in local `.env`, then transfer the refreshed private `.env` to the host and restart Maya.
