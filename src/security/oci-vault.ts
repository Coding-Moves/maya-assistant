import * as common from 'oci-common';
import { SecretsClient } from 'oci-secrets';

/** Retrieves one OCI Vault secret using the VM's instance principal, never a user key. */
export async function readOciVaultSecret(secretId: string): Promise<string> {
  if (!/^ocid1\.vaultsecret\./u.test(secretId)) throw new Error('Invalid OCI Vault secret OCID');
  const provider = await new common.InstancePrincipalsAuthenticationDetailsProviderBuilder().build();
  const client = new SecretsClient({ authenticationDetailsProvider: provider });
  try {
    const response = await client.getSecretBundle({ secretId });
    const content = response.secretBundle.secretBundleContent?.content;
    if (!content) throw new Error('OCI Vault returned an empty secret');
    const value = Buffer.from(content, 'base64').toString('utf8').trim();
    if (!value) throw new Error('OCI Vault returned an empty secret');
    return value;
  } finally {
    client.close();
  }
}
