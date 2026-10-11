#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Create a verified offline backup of one BHAI GARAGE libvirt VPS disk.

Usage:
  sudo env BHAI_VM_BACKUP_DIR=/mnt/off-host-backups bash scripts/backup-vps-disks.sh bg-<32-hex-vps-id>

Safety:
  - Guest must be fully shut off; running, paused, or crashed guests are refused.
  - Destination must be a mounted backup filesystem, outside VM storage.
  - QCOW2 disk is converted to a standalone image (its backing chain is flattened).
  - Backup bundle is published atomically with SHA-256 checksums and inactive domain XML.
  - This backs up one VPS disk and metadata, not the PostgreSQL control-plane database.
USAGE
}

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi
[[ "$#" -eq 1 ]] || { usage >&2; exit 2; }

domain="$1"
[[ "$domain" =~ ^bg-[0-9a-f]{32}$ ]] ||
  fail "Expected a BHAI GARAGE domain name like bg- followed by 32 lowercase hexadecimal characters."

vm_storage="${BHAI_VM_STORAGE:-/var/lib/libvirt/images/bhai-garage-vms}"
backup_dir="${BHAI_VM_BACKUP_DIR:-}"
[[ -n "$backup_dir" ]] ||
  fail "Set BHAI_VM_BACKUP_DIR to a separately mounted backup destination; the script will not silently store backups beside live VM disks."

for tool in virsh qemu-img realpath mountpoint mktemp sha256sum python3 date; do
  command -v "$tool" >/dev/null 2>&1 || fail "Required command is missing: $tool"
done

[[ -d "$vm_storage" && ! -L "$vm_storage" ]] ||
  fail "VM storage must be a real directory, not a symlink: $vm_storage"
[[ -d "$backup_dir" && ! -L "$backup_dir" ]] ||
  fail "Backup destination must already exist as a real directory: $backup_dir"
[[ -w "$backup_dir" ]] || fail "Backup destination is not writable: $backup_dir"
mountpoint -q -- "$backup_dir" ||
  fail "Backup destination is not a mount point. Mount a separate/off-host backup volume before proceeding: $backup_dir"

storage_real="$(realpath -e -- "$vm_storage")"
backup_real="$(realpath -e -- "$backup_dir")"
[[ "$backup_real" != "$storage_real" &&
   "$backup_real" != "$storage_real/"* &&
   "$storage_real" != "$backup_real/"* ]] ||
  fail "Backup destination and live VM storage must be separate, non-nested paths."

guest_dir="$storage_real/$domain"
[[ -d "$guest_dir" && ! -L "$guest_dir" ]] ||
  fail "VPS storage directory is missing or unsafe: $guest_dir"
guest_real="$(realpath -e -- "$guest_dir")"
[[ "$guest_real" == "$storage_real/$domain" ]] ||
  fail "VPS directory resolves outside the configured VM storage root."
disk_path="$guest_real/root.qcow2"
[[ -f "$disk_path" && ! -L "$disk_path" ]] ||
  fail "VPS root disk is missing or is a symlink: $disk_path"
[[ "$(realpath -e -- "$disk_path")" == "$disk_path" ]] ||
  fail "VPS root disk path resolves unexpectedly: $disk_path"

state="$(virsh --connect qemu:///system domstate "$domain" | tr '[:upper:]' '[:lower:]' | xargs)"
[[ "$state" == "shut off" || "$state" == "shutoff" ]] ||
  fail "VPS must be fully shut off before backup; observed state: ${state:-unknown}. Stop it cleanly and retry."

validate_qcow2() {
  local file="$1"
  local metadata
  metadata="$(qemu-img info --output=json "$file")" ||
    fail "qemu-img could not read image metadata: $file"
  python3 -c 'import json,sys; obj=json.load(sys.stdin); sys.exit(0 if obj.get("format") == "qcow2" else 1)' <<<"$metadata" ||
    fail "VPS disk is not a QCOW2 image: $file"
  qemu-img check -f qcow2 "$file" >/dev/null ||
    fail "QCOW2 consistency check failed: $file"
}

validate_qcow2 "$disk_path"

timestamp="$(date -u +"%Y%m%dT%H%M%SZ")"
bundle_name="$domain-$timestamp"
[[ ! -e "$backup_real/$bundle_name" ]] || bundle_name="$bundle_name-$$"
[[ ! -e "$backup_real/$bundle_name" ]] || fail "Backup destination name already exists: $bundle_name"

temporary_dir="$(mktemp -d "$backup_real/.$bundle_name.tmp.XXXXXXXX")"
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "${temporary_dir:-}" && -d "$temporary_dir" ]]; then
    rm -rf -- "$temporary_dir"
  fi
  exit "$status"
}
trap cleanup EXIT
umask 077

qemu-img convert -p -f qcow2 -O qcow2 "$disk_path" "$temporary_dir/root.qcow2" ||
  fail "qemu-img could not create the standalone backup image."
validate_qcow2 "$temporary_dir/root.qcow2"

virsh --connect qemu:///system dumpxml --inactive "$domain" > "$temporary_dir/domain.xml" ||
  fail "Unable to capture the inactive libvirt domain definition."
qemu-img info --output=json "$temporary_dir/root.qcow2" > "$temporary_dir/disk-info.json"

cat > "$temporary_dir/manifest.txt" <<MANIFEST
format=BHAI-GARAGE-VPS-DISK-BACKUP-V1
domain=$domain
created_at_utc=$timestamp
source_disk=$disk_path
backup_disk=root.qcow2
guest_state_at_backup=shut_off
disk_format=qcow2
backing_chain=flattened
MANIFEST

(
  cd -- "$temporary_dir"
  sha256sum root.qcow2 domain.xml disk-info.json manifest.txt > SHA256SUMS
)
chmod 0600 "$temporary_dir"/root.qcow2 "$temporary_dir"/domain.xml \
  "$temporary_dir"/disk-info.json "$temporary_dir"/manifest.txt "$temporary_dir"/SHA256SUMS

final_dir="$backup_real/$bundle_name"
mv -T -- "$temporary_dir" "$final_dir"
temporary_dir=""
trap - EXIT

printf 'VPS disk backup created: %s\n' "$final_dir"
printf 'Verify with: cd %q && sha256sum --check SHA256SUMS\n' "$final_dir"
