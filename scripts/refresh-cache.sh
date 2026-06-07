#!/bin/zsh

set -euo pipefail

REPO_DIR="/Users/rlim/repos/criterion-imdb"
ENV_FILE="/Users/rlim/.criterion-imdb.env"
LOG_PREFIX="[criterion-imdb-refresh]"
HOSTED_DIR="$REPO_DIR/docs"
HOSTED_CACHE_FILE="$HOSTED_DIR/criterion-cache.json"
HOSTED_REPORT_FILE="$HOSTED_DIR/criterion-movies.html"
HOSTED_INDEX_FILE="$HOSTED_DIR/index.html"
REFRESH_MAX_LOOKUPS="${REFRESH_MAX_LOOKUPS:-300}"

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

/usr/bin/env node "$REPO_DIR/criterion-imdb-suggester.js" --limit all --html --concurrency 2 --max-lookups "$REFRESH_MAX_LOOKUPS"

mkdir -p "$HOSTED_DIR"
cp "$REPO_DIR/firefox-extension/data/criterion-cache.json" "$HOSTED_CACHE_FILE"
cp "$REPO_DIR/.cache/criterion-movies.html" "$HOSTED_REPORT_FILE"
cat > "$HOSTED_INDEX_FILE" <<'EOF'
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0; url=./criterion-movies.html">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Criterion IMDb Report</title>
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      margin: 2rem;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <p><a href="./criterion-movies.html">Open the Criterion IMDb report</a></p>
</body>
</html>
EOF

echo "$LOG_PREFIX finished at $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
