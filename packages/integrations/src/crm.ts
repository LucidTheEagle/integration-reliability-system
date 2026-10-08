import type { AdapterRequestContext, AdapterResult } from "./adapter-result.js";

/** Minimal normalized customer. INFERENCE: the spec defines no attributes. */
export interface Customer {
  readonly id: string;
  readonly name: string;
  readonly email?: string;
}

export interface CreateCustomerInput {
  readonly name: string;
  readonly email?: string;
}

export type UpdateCustomerInput = Partial<CreateCustomerInput>;

/** Spec §9, CRM: create customer. */
export interface CreateCustomerCapability {
  createCustomer(
    input: CreateCustomerInput,
    context?: AdapterRequestContext,
  ): Promise<AdapterResult<Customer>>;
}

/** Spec §9, CRM: get customer. */
export interface GetCustomerCapability {
  getCustomer(
    customerId: string,
    context?: AdapterRequestContext,
  ): Promise<AdapterResult<Customer>>;
}

/** Spec §9, CRM: update customer. */
export interface UpdateCustomerCapability {
  updateCustomer(
    customerId: string,
    input: UpdateCustomerInput,
    context?: AdapterRequestContext,
  ): Promise<AdapterResult<Customer>>;
}

/** Spec §9, CRM: list customers. INFERENCE: no query or pagination yet. */
export interface ListCustomersCapability {
  listCustomers(
    context?: AdapterRequestContext,
  ): Promise<AdapterResult<readonly Customer[]>>;
}