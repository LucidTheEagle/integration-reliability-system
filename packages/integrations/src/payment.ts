import type { AdapterRequestContext, AdapterResult } from "./adapter-result.js";

/**
 * Minimal normalized transaction. INFERENCE: the spec defines no
 * attributes. `status` is a provider-normalized label; no canonical
 * payment-status vocabulary exists, and none is invented here.
 */
export interface Transaction {
  readonly id: string;
  readonly status: string;
}

/**
 * Spec §9, Payment: lookup transaction.
 *
 * This is the only Payment capability defined in Task 009. Payment
 * events emitted by a provider are inbound (webhook) traffic, not
 * something IRS calls, so they are intentionally not modeled here
 * (architect decision, Task 009). Their contract is decided with
 * Task 010 (inbound webhook boundary); Task 018 simulates them.
 */
export interface LookupTransactionCapability {
  lookupTransaction(
    transactionId: string,
    context?: AdapterRequestContext,
  ): Promise<AdapterResult<Transaction>>;
}