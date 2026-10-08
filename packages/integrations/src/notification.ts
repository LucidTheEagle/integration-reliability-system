import type { AdapterRequestContext, AdapterResult } from "./adapter-result.js";

/** Minimal send request. INFERENCE: the spec defines no attributes. */
export interface SendNotificationInput {
  readonly recipient: string;
  readonly subject?: string;
  readonly body: string;
}

/** Minimal normalized receipt. INFERENCE: the spec defines no attributes. */
export interface NotificationReceipt {
  readonly id: string;
}

/** Spec §9, Notification: send notification. */
export interface SendNotificationCapability {
  sendNotification(
    input: SendNotificationInput,
    context?: AdapterRequestContext,
  ): Promise<AdapterResult<NotificationReceipt>>;
}