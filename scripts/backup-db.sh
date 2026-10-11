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
temporary_file="$backup_file.tmp.$"
temporary_checksum="$backup_file.sha256.tmp.$"
restore_list="$backup_file.list.tmp.$"
trap 'rm -f -- "$temporary_file" "$temporary_checksum" "$restore_list"' EXIT

if ! docker compose exec -T db sh -c 'pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom' > "$temporary_file"; then
  echo "PostgreSQL backup failed; the incomplete temporary file will be removed." >&2
  exit 1
fi
if [[ ! -s "$temporary_file" ]]; then
  echo "PostgreSQL backup was empty; refusing to publish it." >&2
  exit 1
fi

# A successful pg_dump process is not enough: validate the archive with the
# database image's pg_restore before publishing a filename that looks usable.
if ! docker compose exec -T db sh -c 'pg_restore --list' < "$temporary_file" > "$restore_list"; then
  echo "PostgreSQL backup is not a readable custom-format archive; refusing to publish it." >&2
  exit 1
fi
if [[ ! -s "$restore_list" ]]; then
  echo "PostgreSQL backup archive has no readable table of contents; refusing to publish it." >&2
  exit 1
fi

chmod 600 "$temporary_file" "$restore_list"
digest="$(sha256sum -- "$temporary_file" | awk '{ print $1 }')"
printf '%s  %s\n' "$digest" "$(basename -- "$backup_file")" > "$temporary_checksum"
chmod 600 "$temporary_checksum"

# Publish each file atomically. If the checksum sidecar cannot be published,
# remove the just-published dump rather than leave an apparently complete backup.
mv -- "$temporary_file" "$backup_file"
if ! mv -- "$temporary_checksum" "$backup_file.sha256"; then
  rm -f -- "$backup_file"
  echo "Could not publish the backup checksum; removed the unverified dump." >&2
  exit 1
fi

# Delete only this script's own old dump/checksum files; never touch unrelated files.
find "$backup_dir" -maxdepth 1 -type f \
  \( -name 'bhai-garage-*.dump' -o -name 'bhai-garage-*.dump.sha256' \) \
  -mtime +"$retention_days" -delete

printf 'Database backup created: %s\n' "$backup_file"
printf 'SHA-256 checksum: %s.sha256\n' "$backup_file"
