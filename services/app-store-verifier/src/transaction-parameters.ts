import { sha256Hex, type VerifiedTransaction } from "./apple.js";
import { transactionStatus } from "./catalog.js";

export function transactionRPCParameters(transaction: VerifiedTransaction, userID: string | null) {
  return {
    p_user_id: userID,
    p_transaction_id: transaction.transactionID,
    p_original_transaction_id: transaction.originalTransactionID,
    p_product_id: transaction.productID,
    p_app_account_token: transaction.appAccountToken,
    p_environment: transaction.environment,
    p_status: transactionStatus(transaction.revocationDate),
    p_purchased_at: new Date(transaction.purchaseDate).toISOString(),
    p_revoked_at: transaction.revocationDate == null
      ? null : new Date(transaction.revocationDate).toISOString(),
    p_signed_at: new Date(transaction.signedDate).toISOString(),
    p_signed_data_sha256_hex: sha256Hex(transaction.signedTransactionInfo),
    p_price_milliunits: transaction.priceMilliunits,
    p_currency: transaction.currency,
  };
}
