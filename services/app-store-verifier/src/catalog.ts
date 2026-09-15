import { entitlementByProduct } from "./product-entitlements.js";
export { entitlementByProduct };

export type SideyProductID = keyof typeof entitlementByProduct;

export function isSideyProductID(value: string): value is SideyProductID {
  return Object.hasOwn(entitlementByProduct, value);
}

export function transactionStatus(revocationDate?: number | null): "active" | "refunded" {
  return revocationDate == null ? "active" : "refunded";
}
