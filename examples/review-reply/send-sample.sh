#!/bin/sh
# Sends a saved payload to your local Tidegate the way GitHub would: signed with GITHUB_WEBHOOK_SECRET.
# Usage: GITHUB_WEBHOOK_SECRET=... ./send-sample.sh samples/review-comment.json [http://localhost:8787]
set -e
file=$1; api=${2:-http://localhost:8787}
sig=$(openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" < "$file" | sed 's/^.* //')
curl -sS "$api/hooks/review-reply/github" -H "content-type: application/json" \
  -H "X-GitHub-Event: pull_request_review_comment" -H "X-GitHub-Delivery: sample-$(od -An -N8 -tx1 /dev/urandom | tr -d " \n")" \
  -H "X-Hub-Signature-256: sha256=$sig" --data-binary @"$file"
echo
