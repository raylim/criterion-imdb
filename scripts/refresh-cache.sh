#!/bin/zsh

set -euo pipefail

REPO_DIR="/Users/rlim/repos/criterion-imdb"
ENV_FILE="/Users/rlim/.criterion-imdb.env"
LOG_PREFIX="[criterion-imdb-refresh]"
HOSTED_CACHE_DIR="$REPO_DIR/docs"
HOSTED_CACHE_FILE="$HOSTED_CACHE_DIR/criterion-cache.json"

echo "$LOG_PREFIX starting at $(date -u +"%Y-%m-%dT%H:%M:%SZ")"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "$LOG_PREFIX missing env file: $ENV_FILE" >&2
  exit 1
fi

source "$ENV_FILE"

if [[ -z "${OMDB_API_KEYS:-}" ]]; then
  echo "$LOG_PREFIX OMDB_API_KEYS is not set" >&2
  exit 1
fi

cd "$REPO_DIR"

/usr/bin/env node "$REPO_DIR/criterion-imdb-suggester.js" --limit all --html --concurrency 8

mkdir -p "$HOSTED_CACHE_DIR"
cp "$REPO_DIR/firefox-extension/data/criterion-cache.json" "$HOSTED_CACHE_FILE"

echo "$LOG_PREFIX finished at $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
