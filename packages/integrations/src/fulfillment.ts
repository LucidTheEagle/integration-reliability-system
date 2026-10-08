import type { AdapterRequestContext, AdapterResult } from "./adapter-result.js";

/** One line of a fulfillment order. INFERENCE: minimal fields. */
export interface FulfillmentOrderItem {
  readonly sku: string;
  readonly quantity: number;
}

/**
 * Minimal normalized fulfillment order. INFERENCE: the spec defines no
 * attributes. Named FulfillmentOrder (not Order) because the spec also
 * has a core-app "order" (§14). `status` is a provider-normalized label
 * with no canonical vocabulary.
 */
export interface FulfillmentOrder {
  readonly id: string;
  readonly status: string;
}

export interface CreateFulfillmentOrderInput {
  readonly reference: string;
  readonly items: readonly FulfillmentOrderItem[];
}

export type UpdateFulfillmentOrderInput = Partial<CreateFulfillmentOrderInput>;

/** Spec §9, Fulfillment: create order. */
export interface CreateOrderCapability {
  createOrder(
    input: CreateFulfillmentOrderInput,
    context?: AdapterRequestContext,
  ): Promise<AdapterResult<FulfillmentOrder>>;
}

/** Spec §9, Fulfillment: get order. */
export interface GetOrderCapability {
  getOrder(
    orderId: string,
    context?: AdapterRequestContext,
  ): Promise<AdapterResult<FulfillmentOrder>>;
}

/** Spec §9, Fulfillment: update order. */
export interface UpdateOrderCapability {
  updateOrder(
    orderId: string,
    input: UpdateFulfillmentOrderInput,
    context?: AdapterRequestContext,
  ): Promise<AdapterResult<FulfillmentOrder>>;
}