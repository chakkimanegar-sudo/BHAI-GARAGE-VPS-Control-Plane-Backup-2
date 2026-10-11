#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
temporary_root="$(mktemp -d)"
trap 'rm -rf -- "$temporary_root"' EXIT
fake_bin="$temporary_root/bin"
vm_storage="$temporary_root/vms"
backup_dir="$temporary_root/off-host-backups"
domain="bg-00000000000040008000000000000002"
guest_dir="$vm_storage/$domain"
mkdir -p "$fake_bin" "$guest_dir" "$backup_dir"
printf 'FAKE-QCOW2-DISK\\n' > "$guest_dir/root.qcow2"
export PATH="$fake_bin:$PATH"
export FAKE_VPS_STATE="shut off"
export FAKE_QEMU_FORMAT="qcow2"

cat > "$fake_bin/mountpoint" <<'FAKE_MOUNTPOINT'
#!/usr/bin/env bash
exit 0
FAKE_MOUNTPOINT
cat > "$fake_bin/virsh" <<'FAKE_VIRSH'
#!/usr/bin/env bash
set -Eeuo pipefail
case "${3:-}" in
  domstate) printf '%s\\n' "${FAKE_VPS_STATE:-shut off}" ;;
  dumpxml)
    printf "<domain><name>%s</name><devices><disk file='%s'/></devices></domain>\\n" "$4" "$FAKE_DOMAIN_DISK"
    ;;
  *) echo "Unexpected virsh command: $*" >&2; exit 90 ;;
esac
FAKE_VIRSH
cat > "$fake_bin/qemu-img" <<'FAKE_QEMU_IMG'
#!/usr/bin/env bash
set -Eeuo pipefail
case "${1:-}" in
  info)
    printf '{"format":"%s","virtual-size":8589934592}\\n' "${FAKE_QEMU_FORMAT:-qcow2}"
    ;;
  check)
    [[ -s "${4:-}" ]] || exit 1
    ;;
  convert)
    [[ "${FAKE_QEMU_FORMAT:-qcow2}" == "qcow2" ]] || exit 1
    cp -- "${7:?source disk missing}" "${8:?backup disk missing}"
    ;;
  *) echo "Unexpected qemu-img command: $*" >&2; exit 91 ;;
esac
FAKE_QEMU_IMG
chmod 700 "$fake_bin/"*

export BHAI_VM_STORAGE="$vm_storage"
export BHAI_VM_BACKUP_DIR="$backup_dir"
export FAKE_DOMAIN_DISK="$guest_dir/root.qcow2"

# Reject malformed names before making a backup bundle.
if bash "$root/scripts/backup-vps-disks.sh" "../root.qcow2" > /dev/null 2>&1; then
  echo "Disk backup unexpectedly accepted a path traversal domain name." >&2
  exit 1
fi

# A running guest is refused, and no backup bundle is published.
export FAKE_VPS_STATE="running"
if bash "$root/scripts/backup-vps-disks.sh" "$domain" > /dev/null 2>&1; then
  echo "Disk backup unexpectedly accepted a running VPS." >&2
  exit 1
fi
[[ -z "$(find "$backup_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]]

# Non-QCOW2 disks must be rejected before publishing any backup.
export FAKE_VPS_STATE="shut off"
export FAKE_QEMU_FORMAT="raw"
if bash "$root/scripts/backup-vps-disks.sh" "$domain" > /dev/null 2>&1; then
  echo "Disk backup unexpectedly accepted a raw disk." >&2
  exit 1
fi
[[ -z "$(find "$backup_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]]

# The valid offline backup must be standalone, checksummed, and permission-restricted.
export FAKE_QEMU_FORMAT="qcow2"
output="$(bash "$root/scripts/backup-vps-disks.sh" "$domain")"
bundle="$(printf '%s\\n' "$output" | sed -n 's/^VPS disk backup created: //p')"
[[ -n "$bundle" && -d "$bundle" ]]
[[ -s "$bundle/root.qcow2" && -s "$bundle/domain.xml" && -s "$bundle/disk-info.json" && -s "$bundle/manifest.txt" && -s "$bundle/SHA256SUMS" ]]
(cd "$bundle" && sha256sum --check SHA256SUMS >/dev/null)
[[ "$(stat -c '%a' "$bundle/root.qcow2")" == "600" ]]
[[ "$(stat -c '%a' "$bundle/SHA256SUMS")" == "600" ]]
grep -Fq "domain=$domain" "$bundle/manifest.txt"
grep -Fq "backing_chain=flattened" "$bundle/manifest.txt"

# Tampering with any backup artifact must be detectable.
printf 'tamper\\n' >> "$bundle/root.qcow2"
if (cd "$bundle" && sha256sum --check SHA256SUMS >/dev/null 2>&1); then
  echo "Disk backup checksum unexpectedly accepted a tampered image." >&2
  exit 1
fi

echo "Offline VPS disk backup tests passed."
