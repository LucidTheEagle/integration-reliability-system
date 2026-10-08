/**
 * @irs/integrations
 *
 * External provider adapters and integration-specific
 * communication logic.
 */

export type {
    AdapterFailure,
    AdapterRequestContext,
    AdapterResult,
  } from "./adapter-result.js";

  export type {
    CreateCustomerCapability,
    CreateCustomerInput,
    Customer,
    GetCustomerCapability,
    ListCustomersCapability,
    UpdateCustomerCapability,
    UpdateCustomerInput,
  } from "./crm.js";

  export type { LookupTransactionCapability, Transaction } from "./payment.js";

  export type {
    CreateFulfillmentOrderInput,
    CreateOrderCapability,
    FulfillmentOrder,
    FulfillmentOrderItem,
    GetOrderCapability,
    UpdateFulfillmentOrderInput,
    UpdateOrderCapability,
  } from "./fulfillment.js";

  export type {
    NotificationReceipt,
    SendNotificationCapability,
    SendNotificationInput,
  } from "./notification.js";