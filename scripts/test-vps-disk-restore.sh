#!/usr/bin/env bash
set -Eeuo pipefail

[[ "$EUID" -eq 0 ]] || { echo "Run this test as root (CI uses sudo)." >&2; exit 1; }
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
temporary_root="$(mktemp -d)"
libvirt_root="/var/lib/libvirt/images"
mkdir -p -- "$libvirt_root"
vm_storage="$(mktemp -d "$libvirt_root/.restore-test.XXXXXXXX")"
cleanup() { rm -rf -- "$temporary_root" "$vm_storage"; }
trap cleanup EXIT

fake_bin="$temporary_root/bin"
backups="$temporary_root/off-host-backups"
domains_file="$temporary_root/fake-domains"
first_domain="bg-0123456789abcdef0123456789abcdef"
second_domain="bg-abcdef0123456789abcdef0123456789"
mkdir -p "$fake_bin" "$backups"
: > "$domains_file"

cat > "$fake_bin/virsh" <<'FAKE_VIRSH'
#!/usr/bin/env bash
set -Eeuo pipefail
case "${3:-}" in
  list) cat "$FAKE_DOMAINS" ;;
  net-info) printf 'Name: default\nActive: yes\n' ;;
  define)
    xml="$4"
    name="$(sed -n 's:.*<name>\(.*\)</name>.*:\1:p' "$xml" | head -n 1)"
    [[ "$name" =~ ^bg-[0-9a-f]{32}$ ]] || exit 91
    if grep -Fxq "$name" "$FAKE_DOMAINS"; then exit 92; fi
    printf '%s\n' "$name" >> "$FAKE_DOMAINS"
    ;;
  domstate)
    grep -Fxq "$4" "$FAKE_DOMAINS" || exit 1
    printf 'shut off\n'
    ;;
  *) echo "Unexpected fake virsh command: $*" >&2; exit 90 ;;
esac
FAKE_VIRSH

cat > "$fake_bin/qemu-img" <<'FAKE_QEMU'
#!/usr/bin/env bash
set -Eeuo pipefail
case "${1:-}" in
  info) printf '{"format":"qcow2","virtual-size":21474836480,"actual-size":4096}\n' ;;
  check) [[ -s "${4:-}" ]] ;;
  *) echo "Unexpected fake qemu-img command: $*" >&2; exit 93 ;;
esac
FAKE_QEMU
chmod 0700 "$fake_bin/"*
export PATH="$fake_bin:$PATH"
export FAKE_DOMAINS="$domains_file"
export BHAI_VM_STORAGE="$vm_storage"
export BHAI_AGENT_UID=0
export BHAI_QEMU_GID="$(id -g)"

make_bundle() {
  local domain="$1"
  local bundle="$backups/$domain-bundle"
  mkdir -p "$bundle"
  printf 'FAKE-QCOW2-DISK %s\n' "$domain" > "$bundle/root.qcow2"
  printf 'FAKE-CLOUD-INIT-ISO %s\n' "$domain" > "$bundle/cloud-init.iso"
  printf '{"format":"qcow2","virtual-size":21474836480}\n' > "$bundle/disk-info.json"
  cat > "$bundle/domain.xml" <<XML
<domain type="kvm"><name>${domain}</name><memory unit="MiB">2048</memory><currentMemory unit="MiB">2048</currentMemory><vcpu placement="static">2</vcpu><devices><disk type="file" device="disk"><source file="/old/vms/${domain}/root.qcow2"/><target dev="vda" bus="virtio"/></disk><disk type="file" device="cdrom"><source file="/old/vms/${domain}/cloud-init.iso"/><target dev="sda" bus="sata"/></disk></devices></domain>
XML
  cat > "$bundle/manifest.txt" <<MANIFEST
format=BHAI-GARAGE-VPS-DISK-BACKUP-V1
domain=$domain
created_at_utc=20261011T000000Z
source_disk=/old/vms/$domain/root.qcow2
backup_disk=root.qcow2
guest_state_at_backup=shut_off
disk_format=qcow2
backing_chain=flattened
MANIFEST
  (cd "$bundle" && sha256sum root.qcow2 domain.xml disk-info.json manifest.txt cloud-init.iso > SHA256SUMS)
  printf '%s' "$bundle"
}

first_bundle="$(make_bundle "$first_domain")"
if bash "$root/scripts/restore-vps-disk-backup.sh" "$first_bundle" > /dev/null 2>&1; then
  echo "Restore unexpectedly accepted a missing confirmation." >&2
  exit 1
fi
[[ ! -e "$vm_storage/$first_domain" ]]
[[ ! -s "$domains_file" ]]

output="$(bash "$root/scripts/restore-vps-disk-backup.sh" "$first_bundle" --confirm)"
grep -Fq "VPS disk restored and domain defined (not started): $first_domain" <<<"$output"
restored="$vm_storage/$first_domain"
[[ -s "$restored/root.qcow2" && -s "$restored/cloud-init.iso" && -s "$restored/domain.xml" ]]
[[ "$(stat -c '%a' "$restored")" == "2710" ]]
[[ "$(stat -c '%a' "$restored/root.qcow2")" == "660" ]]
[[ "$(stat -c '%a' "$restored/cloud-init.iso")" == "640" ]]
grep -Fxq "$first_domain" "$domains_file"
grep -Fq "file=\"$restored/root.qcow2\"" "$restored/domain.xml"
grep -Fq 'network="default"' "$restored/domain.xml"
! grep -Fq 'type="bridge"' "$restored/domain.xml"

before="$(sha256sum "$restored/root.qcow2")"
if bash "$root/scripts/restore-vps-disk-backup.sh" "$first_bundle" --confirm > /dev/null 2>&1; then
  echo "Restore unexpectedly overwrote an existing domain." >&2
  exit 1
fi
[[ "$(sha256sum "$restored/root.qcow2")" == "$before" ]]

second_bundle="$(make_bundle "$second_domain")"
printf 'tamper\n' >> "$second_bundle/root.qcow2"
if bash "$root/scripts/restore-vps-disk-backup.sh" "$second_bundle" --confirm > /dev/null 2>&1; then
  echo "Restore unexpectedly accepted a tampered disk bundle." >&2
  exit 1
fi
[[ ! -e "$vm_storage/$second_domain" ]]
! grep -Fxq "$second_domain" "$domains_file"

echo "Verified VPS disk restore tests passed."
