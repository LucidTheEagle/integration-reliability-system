import type { WebhookSecrets } from "@irs/config";

/**
 * Resolves the webhook secret for an integration ID, or undefined when no
 * secret is configured (the caller must then fail closed). There is no
 * database lookup and no identifier-mapping layer: the key is the
 * `Integration.id` itself (D-016, D-017).
 */
export type SecretResolver = (integrationId: string) => Uint8Array | undefined;

export function createSecretResolver(secrets: WebhookSecrets): SecretResolver {
  // Snapshot so later mutation of the caller's map cannot change resolution.
  const snapshot = new Map(secrets);
  return (integrationId) => snapshot.get(integrationId);
}
