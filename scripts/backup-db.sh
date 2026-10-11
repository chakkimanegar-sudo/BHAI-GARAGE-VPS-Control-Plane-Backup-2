#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

backup_dir="${BHAI_BACKUP_DIR:-$repo_root/backups/postgres}"
retention_days="${BHAI_BACKUP_RETENTION_DAYS:-14}"

if [[ ! "$retention_days" =~ ^[1-9][0-9]{0,3}$ ]] || (( retention_days > 3650 )); then
  echo "BHAI_BACKUP_RETENTION_DAYS must be an integer from 1 to 3650." >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required to back up the Compose PostgreSQL service." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin is required." >&2
  exit 1
fi
if ! command -v sha256sum >/dev/null 2>&1; then
  echo "sha256sum is required to verify backup integrity." >&2
  exit 1
fi

umask 077
mkdir -p -- "$backup_dir"
timestamp="$(date -u +"%Y%m%dT%H%M%SZ")"
backup_file="$backup_dir/bhai-garage-$timestamp.dump"
if [[ -e "$backup_file" || -e "$backup_file.sha256" ]]; then
  backup_file="$backup_dir/bhai-garage-$timestamp-$$.dump"
fi
temporary_file="$backup_file.tmp.$$"
trap 'rm -f -- "$temporary_file"' EXIT

if ! docker compose exec -T db sh -c 'pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom' > "$temporary_file"; then
  echo "PostgreSQL backup failed; the incomplete temporary file will be removed." >&2
  exit 1
fi
if [[ ! -s "$temporary_file" ]]; then
  echo "PostgreSQL backup was empty; refusing to publish it." >&2
  exit 1
fi

chmod 600 "$temporary_file"
mv -- "$temporary_file" "$backup_file"
(
  cd -- "$backup_dir"
  sha256sum "$(basename -- "$backup_file")" > "$(basename -- "$backup_file").sha256"
)
chmod 600 "$backup_file.sha256"

# Delete only this script's own old dump/checksum files; never touch unrelated files.
find "$backup_dir" -maxdepth 1 -type f \
  \( -name 'bhai-garage-*.dump' -o -name 'bhai-garage-*.dump.sha256' \) \
  -mtime +"$retention_days" -delete

printf 'Database backup created: %s\n' "$backup_file"
printf 'SHA-256 checksum: %s.sha256\n' "$backup_file"
