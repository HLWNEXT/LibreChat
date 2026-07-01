#!/usr/bin/env bash
# Copies all collections from one MongoDB-compatible URI to another via
# mongodump/mongorestore (requires MongoDB Database Tools on PATH).
# Used to migrate the local dev database to Azure Cosmos DB for MongoDB (vCore).
#
# Usage:
#   scripts/db/migrate.sh --source <uri> --target <uri>
#
# Example:
#   scripts/db/migrate.sh \
#     --source "mongodb://127.0.0.1:27017/Norm-LibreChat" \
#     --target "mongodb+srv://user:pass@cluster.mongocluster.cosmos.azure.com/Norm-LibreChat?tls=true&authMechanism=SCRAM-SHA-256&retrywrites=false"
#
# The target database name in the URI path determines the restored database name.

set -euo pipefail

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE_URI="$2"; shift 2 ;;
    --target) TARGET_URI="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "${SOURCE_URI:-}" || -z "${TARGET_URI:-}" ]]; then
  echo "Usage: $0 --source <uri> --target <uri>" >&2
  exit 1
fi

DUMP_DIR="$(mktemp -d)"
trap 'rm -rf "$DUMP_DIR"' EXIT

echo "Dumping from source..."
mongodump --uri="$SOURCE_URI" --out="$DUMP_DIR"

SOURCE_DB="$(basename "$(echo "$SOURCE_URI" | sed -E 's#^[a-z+]+://[^/]+/##; s#\?.*##')")"
TARGET_DB="$(basename "$(echo "$TARGET_URI" | sed -E 's#^[a-z+]+://[^/]+/##; s#\?.*##')")"

if [[ -z "$SOURCE_DB" || -z "$TARGET_DB" ]]; then
  echo "Both --source and --target URIs must include a database name in the path." >&2
  exit 1
fi

echo "Restoring into target database '$TARGET_DB'..."
mongorestore --uri="$TARGET_URI" --dir="$DUMP_DIR/$SOURCE_DB" \
  --nsFrom="$SOURCE_DB.*" --nsTo="$TARGET_DB.*"

echo "Done."
