#!/bin/sh
set -eu

: "${SIDEY_STAGING_PROJECT_REF:?SIDEY_STAGING_PROJECT_REF is required}"
: "${SIDEY_STAGING_DATABASE_URL:?SIDEY_STAGING_DATABASE_URL is required}"
: "${PORTONE_STORE_ID:?PORTONE_STORE_ID is required}"
: "${PORTONE_CHANNEL_KEY:?PORTONE_CHANNEL_KEY is required}"
: "${PORTONE_API_SECRET:?PORTONE_API_SECRET is required}"
: "${PORTONE_WEBHOOK_SECRET:?PORTONE_WEBHOOK_SECRET is required}"

if [ "$SIDEY_STAGING_PROJECT_REF" = "whtejsviizgejauasqqt" ]; then
  echo "Refusing to configure the SIDEY production project as staging." >&2
  exit 1
fi

case "$SIDEY_STAGING_DATABASE_URL" in
  *whtejsviizgejauasqqt*)
    echo "Refusing to use the SIDEY production database URL." >&2
    exit 1
    ;;
esac

supabase link --project-ref "$SIDEY_STAGING_PROJECT_REF"
supabase db push --linked --include-all
supabase secrets set --project-ref "$SIDEY_STAGING_PROJECT_REF" \
  PORTONE_STORE_ID="$PORTONE_STORE_ID" \
  PORTONE_CHANNEL_KEY="$PORTONE_CHANNEL_KEY" \
  PORTONE_API_SECRET="$PORTONE_API_SECRET" \
  PORTONE_WEBHOOK_SECRET="$PORTONE_WEBHOOK_SECRET"

PGOPTIONS="-c app.settings.sidey_environment=staging" \
  psql "$SIDEY_STAGING_DATABASE_URL" \
  --set ON_ERROR_STOP=1 \
  --file supabase/staging/enable_test_commerce.sql

echo "SIDEY-staging migrations, PortOne secrets, and test sales flag configured."
