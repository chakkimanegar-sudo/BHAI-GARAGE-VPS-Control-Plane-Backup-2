#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
temporary_root="$(mktemp -d)"
trap 'rm -rf -- "$temporary_root"' EXIT
fake_bin="$temporary_root/bin"
backup_dir="$temporary_root/backups"
restore_marker="$temporary_root/restore-called"
mkdir -p "$fake_bin" "$backup_dir"

cat > "$fake_bin/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" == "compose" && "${2:-}" == "version" ]]; then
  exit 0
fi
if [[ "${1:-}" == "compose" && "${2:-}" == "exec" && "${3:-}" == "-T" && "${4:-}" == "db" ]]; then
  if [[ "$*" == *pg_dump* ]]; then
    if [[ "${FAKE_INVALID_DUMP:-0}" == "1" ]]; then
      printf 'NOT-A-POSTGRES-ARCHIVE\n'
    else
      printf 'FAKE-CUSTOM-POSTGRES-ARCHIVE\n'
    fi
    exit 0
  fi
  if [[ "$*" == *pg_restore* && "$*" == *--list* ]]; then
    archive="$(cat)"
    if [[ "$archive" == *FAKE-CUSTOM-POSTGRES-ARCHIVE* ]]; then
      printf 'FAKE ARCHIVE TABLE OF CONTENTS\n'
      exit 0
    fi
    echo "pg_restore: error: input file does not appear to be a valid archive" >&2
    exit 2
  fi
  if [[ "$*" == *pg_restore* ]]; then
    cat >/dev/null
    printf 'restored\n' > "$FAKE_RESTORE_MARKER"
    exit 0
  fi
fi
echo "Unexpected fake docker invocation: $*" >&2
exit 99
FAKE_DOCKER
chmod 700 "$fake_bin/docker"
export FAKE_RESTORE_MARKER="$restore_marker"
export PATH="$fake_bin:$PATH"
export BHAI_BACKUP_DIR="$backup_dir"
export BHAI_BACKUP_RETENTION_DAYS=14

old_dump="$backup_dir/bhai-garage-20000101T000000Z.dump"
printf 'old backup\n' > "$old_dump"
printf 'old checksum\n' > "$old_dump.sha256"
touch -d '20 days ago' "$old_dump" "$old_dump.sha256"

# Even when pg_dump exits successfully, an unreadable archive must not be published.
before_dumps="$(find "$backup_dir" -maxdepth 1 -type f -name 'bhai-garage-*.dump' | wc -l)"
export FAKE_INVALID_DUMP=1
if bash "$root/scripts/backup-db.sh" >"$temporary_root/invalid-backup.out" 2>&1; then
  echo "Backup unexpectedly published a corrupt PostgreSQL archive." >&2
  exit 1
fi
unset FAKE_INVALID_DUMP
after_dumps="$(find "$backup_dir" -maxdepth 1 -type f -name 'bhai-garage-*.dump' | wc -l)"
[[ "$before_dumps" == "$after_dumps" ]]
if find "$backup_dir" -maxdepth 1 -type f \( -name '*.tmp.*' -o -name '*.list.tmp.*' \) | grep -q .; then
  echo "A failed backup left temporary files behind." >&2
  exit 1
fi

backup_output="$(bash "$root/scripts/backup-db.sh")"
backup_file="$(printf '%s\n' "$backup_output" | sed -n 's/^Database backup created: //p')"
[[ -n "$backup_file" && -s "$backup_file" ]]
[[ -s "$backup_file.sha256" ]]
[[ "$(stat -c '%a' "$backup_file")" == "600" ]]
[[ ! -e "$old_dump" && ! -e "$old_dump.sha256" ]]

# A restore must never proceed without an explicit confirmation argument.
if bash "$root/scripts/restore-db.sh" "$backup_file" > /dev/null 2>&1; then
  echo "Restore unexpectedly accepted a missing confirmation." >&2
  exit 1
fi
[[ ! -e "$restore_marker" ]]

# A tampered archive must be rejected before Docker/pg_restore is invoked.
printf 'tamper\n' >> "$backup_file"
if bash "$root/scripts/restore-db.sh" "$backup_file" --confirm > /dev/null 2>&1; then
  echo "Restore unexpectedly accepted a checksum mismatch." >&2
  exit 1
fi
[[ ! -e "$restore_marker" ]]

# Recreate a valid archive/checksum and verify the confirmed restore path only.
printf 'FAKE-CUSTOM-POSTGRES-ARCHIVE\n' > "$backup_file"
(cd "$backup_dir" && sha256sum "$(basename "$backup_file")" > "$(basename "$backup_file").sha256")
bash "$root/scripts/restore-db.sh" "$backup_file" --confirm > /dev/null
[[ -s "$restore_marker" ]]

echo "Database backup/restore script tests passed."
