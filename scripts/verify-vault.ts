import { configuredVaultSecrets } from '../src/security/runtime-secrets.js';
import { readOciVaultSecret } from '../src/security/oci-vault.js';

const secrets = configuredVaultSecrets();
if (secrets.length === 0) throw new Error('No OCI Vault secret references are configured');

await Promise.all(secrets.map(async ({ name, secretId }) => {
  await readOciVaultSecret(secretId);
  process.stdout.write(`${name}: available from OCI Vault\n`);
}));
