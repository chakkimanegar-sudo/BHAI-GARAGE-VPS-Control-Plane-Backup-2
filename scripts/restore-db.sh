#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 2 || "$2" != "--confirm" ]]; then
  echo "Usage: bash scripts/restore-db.sh <backup.dump> --confirm" >&2
  echo "WARNING: this replaces matching database objects. Stop the API and take a fresh backup first." >&2
  exit 2
fi

backup_file="$1"
if [[ ! -f "$backup_file" || ! -s "$backup_file" ]]; then
  echo "Backup file does not exist or is empty: $backup_file" >&2
  exit 1
fi
checksum_file="$backup_file.sha256"
if [[ ! -f "$checksum_file" ]]; then
  echo "Checksum file is missing: $checksum_file" >&2
  exit 1
fi
if ! command -v sha256sum >/dev/null 2>&1; then
  echo "sha256sum is required to verify backup integrity." >&2
  exit 1
fi

expected="$(awk 'NR == 1 { print $1; exit }' "$checksum_file")"
if [[ ! "$expected" =~ ^[a-fA-F0-9]{64}$ ]]; then
  echo "Checksum file has an invalid SHA-256 digest." >&2
  exit 1
fi
actual="$(sha256sum -- "$backup_file" | awk '{ print $1 }')"
if [[ "$expected" != "$actual" ]]; then
  echo "Backup checksum mismatch; refusing to restore." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo "Docker Engine and the Compose plugin are required." >&2
  exit 1
fi

echo "Restoring database objects from $backup_file ..."
docker compose exec -T db sh -c 'pg_restore --clean --if-exists --no-owner --exit-on-error --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' < "$backup_file"
echo "Database restore command completed. Verify the application before restarting the API."
