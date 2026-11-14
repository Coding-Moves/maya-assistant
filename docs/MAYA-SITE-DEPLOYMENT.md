# Maya public site and Google OAuth publishing

This guide deploys the small public site in [`site/`](../site/) to `maya.codingmoves.com`. The site is deliberately static: it has no forms, login, analytics, database, WhatsApp session, Calendar token, API key, or LMS credential. It is a Coding Moves Lab project page, with prominent links to the official [Maya Lab page](https://codingmoves.com/lab/maya/) and [Lab contact form](https://codingmoves.com/lab/contact/). This avoids collecting the same visitor message in two places: contact submissions stay on the official Coding Moves site, where Netlify Forms handles them.

## What this fixes

Maya's Google Calendar OAuth client uses the desktop authorization flow, but Google still asks an external app for valid branding information before its publishing status can be changed from **Testing** to **In production**. While it is in Testing, Calendar refresh tokens expire after seven days. The public site supplies these URLs:

- Home: `https://maya.codingmoves.com/`
- Privacy policy: `https://maya.codingmoves.com/privacy/`
- Terms: `https://maya.codingmoves.com/terms/`

Publishing an OAuth app does not make Maya public, does not expose its credentials, and does not give anyone else access to the owner's Calendar. The desktop OAuth client and its localhost callback remain unchanged.

## 1. Deploy the site with Netlify

After the PR containing this guide is merged:

1. In Netlify, choose **Add new project** → **Import an existing project** → **GitHub**.
2. Select the `Coding-Moves/maya-assistant` repository and the `main` branch.
3. Leave **Base directory** empty. Use a blank build command and set the **Publish directory** to `site`. The committed [`netlify.toml`](../netlify.toml) records the same settings.
4. Deploy. Before adding the custom domain, open the generated `*.netlify.app` URL and verify the home page, `/privacy/`, and `/terms/` load.
5. In the Netlify site configuration, add the custom domain `maya.codingmoves.com`. Netlify will show the exact DNS target it expects.

Do not connect Netlify to `.env`, the Oracle VM, or the production database. This deploy needs only the public Git repository contents.

## 2. Point Cloudflare DNS at Netlify

In the `codingmoves.com` Cloudflare zone, create the DNS record Netlify requested. For the usual Netlify configuration:

| Field | Value |
| --- | --- |
| Type | `CNAME` |
| Name | `maya` |
| Target | the `your-site.netlify.app` hostname shown by Netlify |
| Proxy status | **DNS only** (grey cloud) while Netlify verifies the domain and provisions TLS |

Do not create an `A` record for this subdomain and do not replace the existing `codingmoves.com` records. Wait for Netlify to report that HTTPS is provisioned, then open all three `https://maya.codingmoves.com` URLs in a private browser window. Keep the record DNS-only if Netlify asks for direct DNS validation; change its proxy setting only if both Cloudflare and Netlify document that configuration for this site.

## 3. Complete Google Auth Platform branding

Only do this after the HTTPS URLs above work publicly.

1. Open the **Maya Assistant** Google Cloud project → **Google Auth Platform** → **Branding**.
2. Set the app name to `Maya Assistant`.
3. Set the user support email and developer contact email to an address the project owner actively monitors.
4. Under **Authorised domains**, add `codingmoves.com` — the registrable parent domain, not `maya.codingmoves.com`. If Google requests it, verify ownership of `codingmoves.com` in [Google Search Console](https://search.google.com/search-console/) with a Google account that is an owner or editor of this Cloud project.
5. Set the application home page to `https://maya.codingmoves.com/`.
6. Set the privacy policy link to `https://maya.codingmoves.com/privacy/`.
7. The terms link can be `https://maya.codingmoves.com/terms/`. A logo is optional; leave it blank unless you want to maintain it.
8. Save Branding, then open **Audience** and choose **Publish app** / **In production**. Read and accept Google's confirmation carefully.

The Calendar scope can still require Google brand or scope verification before the app is broadly trusted by accounts outside the project. For this personal single-owner integration, do not add unrelated people as test users and do not claim Google verification has been completed unless Google confirms it. Google requires a public homepage, linked privacy policy, and verified authorized domain for production branding; its [verification guidance](https://developers.google.com/identity/verification/authentication-verification) explains the requirements.

## 4. Re-authorize the owner Calendar

Publishing does not repair the existing expired Testing-mode refresh token. Re-authorize it once:

1. On the owner’s own computer, confirm local `.env` contains the exact `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` for the same Google Cloud project. Values may be quoted only if the quotes are part of a standard dotenv value; do not add spaces around `=`.
2. Stop a local Maya process if it would share the VM's WhatsApp session.
3. Run `npm run calendar-auth` from the repository root.
4. Open the printed authorization URL, sign in as the owner, and approve Calendar access. Wait for the browser to show the callback completion message.
5. Keep the resulting `.env` private. Transfer it securely to `/opt/maya-assistant/.env` on the Oracle VM, restrict it to the `ubuntu` account, and run `sudo systemctl restart maya`.
6. Confirm with `sudo systemctl status maya --no-pager` and `sudo journalctl -u maya -n 80 --no-pager`. Ask Maya privately about upcoming Calendar events or create a dated test task to verify the live connection.

Never commit `.env`, copy it into the Netlify project, paste its values into chat, or put a Google OAuth secret into the static site.

## Ongoing maintenance

- Update the policy pages in `site/` if Maya's data handling changes, then deploy from `main` through Netlify.
- A published app's refresh token can still stop working if access is revoked, the account's security policy intervenes, or it has been unused for a long time. Repeat step 4 if Maya logs `invalid_grant`.
- Keep `contactmuawia@gmail.com` (or the configured developer contact) reachable for Google notices.
