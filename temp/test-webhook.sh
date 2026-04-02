#!/usr/bin/env bash
# Usage:
#   ./scripts/test-webhook.sh <tenantId> [senderEmail]
#
# Env override:
#   PLUSVIBE_WEBHOOK_SECRET=xxx ./scripts/test-webhook.sh <tenantId>
#
# Examples:
#   ./scripts/test-webhook.sh dc4173b4-8fb4-4b9c-9628-a2e2d5f14098
#   ./scripts/test-webhook.sh dc4173b4-8fb4-4b9c-9628-a2e2d5f14098 ali@ornek.com

set -euo pipefail

TENANT_ID="${1:?Usage: $0 <tenantId> [senderEmail]}"
SENDER="${2:-test-reply@example.com}"
PORT="${API_PORT:-3001}"

# Read secret from env or .env file
if [ -z "${PLUSVIBE_WEBHOOK_SECRET:-}" ]; then
  SECRET=$(grep -E '^PLUSVIBE_WEBHOOK_SECRET=' .env 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'")
  if [ -z "$SECRET" ]; then
    echo "ERROR: PLUSVIBE_WEBHOOK_SECRET not set in env or .env file" >&2
    exit 1
  fi
else
  SECRET="$PLUSVIBE_WEBHOOK_SECRET"
fi

PAYLOAD=$(cat <<EOF
{
  "event": "replied",
  "campaign_id": "test-campaign-001",
  "campaign_name": "Test Campaign",
  "recipient_email": "${SENDER}",
  "reply_body": "Merhaba, teklifinizle ilgileniyoruz. Görüşmek için uygun musunuz?",
  "replied_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
)

echo "→ POST http://localhost:${PORT}/api/webhooks/plusvibe/${TENANT_ID}"
echo "→ Sender: ${SENDER}"
echo ""

SIG=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "http://localhost:${PORT}/api/webhooks/plusvibe/${TENANT_ID}" \
  -H "Content-Type: application/json" \
  -H "signature: ${SIG}" \
  -d "$PAYLOAD")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n -1)

echo "HTTP $HTTP_CODE"
echo "$BODY" | (command -v jq >/dev/null 2>&1 && jq . || cat)
