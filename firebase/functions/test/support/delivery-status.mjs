export function validateDeliveryStatus(value, expectedUsers, {requireSettled = true} = {}) {
  if (!Number.isSafeInteger(expectedUsers) || expectedUsers < 1 || expectedUsers > 10 ||
      !value || typeof value.ready !== "boolean" ||
      value.expected_users !== expectedUsers ||
      !Number.isSafeInteger(value.settled_users) ||
      !Number.isSafeInteger(value.access_pending) ||
      !Number.isSafeInteger(value.room_pending) ||
      !Number.isSafeInteger(value.chat_publish_pending) ||
      !Number.isSafeInteger(value.chat_cleanup_pending) ||
      (requireSettled && value.settled_users !== expectedUsers)) {
    throw new Error("invalid_delivery_status");
  }
  return value;
}
