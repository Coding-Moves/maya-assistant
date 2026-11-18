# OCI Vault for production secrets

This guide is for Maya running on an Oracle Cloud VM. It moves secret *values* out of the VM configuration file while keeping normal settings easy to inspect and change.

Maya keeps `/opt/maya-assistant/.env`, but production values in it should be only settings and OCI secret OCIDs. The actual API keys, passwords and OAuth tokens live as separate encrypted Oracle Vault secrets. Maya's VM uses its instance identity to read only the secrets it needs.

## What belongs in Vault

Create one secret for each value. Do not combine them into one `.env`-shaped secret: separate values can be rotated independently and receive separate least-privilege permissions.

| Suggested secret name | Maya configuration reference | Purpose |
| --- | --- | --- |
| `maya-gemini-api-key` | `GEMINI_API_KEY_SECRET_OCID` | Gemini API key |
| `maya-vu-student-id` | `VU_STUDENT_ID_SECRET_OCID` | VU student identifier |
| `maya-vu-password` | `VU_PASSWORD_SECRET_OCID` | VU LMS password |
| `maya-google-client-secret` | `GOOGLE_CLIENT_SECRET_SECRET_OCID` | Google OAuth client secret |
| `maya-google-refresh-token` | `GOOGLE_REFRESH_TOKEN_SECRET_OCID` | Google Calendar refresh token |
| Existing `maya-nfc-student-id` | `NFC_STUDENT_ID_SECRET_OCID` | NFC CMS student identifier |
| Existing `maya-nfc-password` | `NFC_PASSWORD_SECRET_OCID` | NFC CMS password |

`GOOGLE_CLIENT_ID` is an identifier, not a credential, so it stays in `.env`. Bot name, schedules, timezone, owner JID and feature flags also stay in `.env`.

Do **not** move `auth_info/` or `data/` into Vault. They are changing files, not individual configuration values. Keep them on Maya's persistent encrypted VM disk with their existing restrictive permissions.

## Create or migrate the secrets

1. Open the existing `maya-secrets` standard Vault in Oracle Cloud. Use the existing software-protected master key.
2. Create the five new secrets in the table above. For each one, choose **Manual secret generation**, paste the value yourself, and create it. Do not use automatic generation for a password or API key you already own.
3. Copy each secret's **OCID**. An OCID is a reference, not the secret value; still keep it private.
4. Edit the VM configuration with `sudo nano /opt/maya-assistant/.env`. Replace each direct value with its OCID reference. For example:

   ```dotenv
   GEMINI_API_KEY=
   GEMINI_API_KEY_SECRET_OCID=ocid1.vaultsecret...

   VU_STUDENT_ID=
   VU_PASSWORD=
   VU_STUDENT_ID_SECRET_OCID=ocid1.vaultsecret...
   VU_PASSWORD_SECRET_OCID=ocid1.vaultsecret...

   GOOGLE_CLIENT_ID=your-public-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=
   GOOGLE_REFRESH_TOKEN=
   GOOGLE_CLIENT_SECRET_SECRET_OCID=ocid1.vaultsecret...
   GOOGLE_REFRESH_TOKEN_SECRET_OCID=ocid1.vaultsecret...
   ```

   Never leave a direct value and its `_SECRET_OCID` together. Maya rejects that ambiguous setup at startup so a forgotten plaintext secret cannot silently remain in use.
5. Keep the existing NFC OCID references unchanged. NFC already reads its values from Vault.

## Give only Maya's VM access

Use the existing `maya-vm-secret-reader` dynamic group, which matches only the `maya-e2-free` instance. Edit its `maya-vm-read-nfc-secrets` policy and add one rule per new secret OCID:

```text
Allow dynamic-group maya-vm-secret-reader to read secret-bundles in tenancy where target.secret.id = '<GEMINI_SECRET_OCID>'
Allow dynamic-group maya-vm-secret-reader to read secret-bundles in tenancy where target.secret.id = '<VU_STUDENT_ID_SECRET_OCID>'
Allow dynamic-group maya-vm-secret-reader to read secret-bundles in tenancy where target.secret.id = '<VU_PASSWORD_SECRET_OCID>'
Allow dynamic-group maya-vm-secret-reader to read secret-bundles in tenancy where target.secret.id = '<GOOGLE_CLIENT_SECRET_OCID>'
Allow dynamic-group maya-vm-secret-reader to read secret-bundles in tenancy where target.secret.id = '<GOOGLE_REFRESH_TOKEN_SECRET_OCID>'
```

Do not grant `manage secret-family`, broad `read secret-bundles`, a policy for the whole Vault, or a user API key to the VM. These rules let that one VM read exactly these named secret bundles and nothing else. Oracle documents secret-specific policy conditions in its [Vault policy reference](https://docs.oracle.com/en-us/iaas/Content/Identity/Reference/keypolicyreference.htm).

## Verify and restart

From the VM, run:

```bash
cd /opt/maya-assistant
sudo -u maya npm run verify-vault
sudo systemctl restart maya
sudo systemctl status maya --no-pager
sudo journalctl -u maya -n 80 --no-pager
```

`npm run verify-vault` retrieves every configured Vault secret but prints only its configuration name and availability, never its value. If a policy or OCID is wrong, it fails before Maya is restarted.

## Rotate a value later

1. In Oracle Cloud Console, open the existing secret and choose **Create secret version**.
2. Select **Manual secret generation**, enter the replacement value yourself, and create the new current version.
3. Restart Maya for immediate use of the new value:

   ```bash
   sudo systemctl restart maya
   ```

The OCID stays the same. No source-code change, Git commit or `.env` edit is needed for ordinary rotation.

## Local development and Calendar authorization

Local development remains simple: use direct values in a local, ignored `.env` and leave every `_SECRET_OCID` blank. OCI Vault needs a running Oracle instance identity, so it is not required for a local clone.

`npm run calendar-auth` intentionally writes a refresh token to the **local** `.env` after you approve Google access. For a production Vault setup, create the refresh token locally, paste it into a new version of `maya-google-refresh-token` yourself, then remove the direct local copy if you no longer need it. Never paste it into chat or Git.
