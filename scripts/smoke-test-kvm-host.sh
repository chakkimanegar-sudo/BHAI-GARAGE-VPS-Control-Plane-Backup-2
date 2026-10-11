#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Run an isolated real KVM/libvirt guest boot and private-NAT DHCP smoke test.

Usage:
  sudo bash scripts/smoke-test-kvm-host.sh

The test creates one uniquely named temporary Ubuntu guest on libvirt's default
NAT network, waits for its DHCP lease, then undefines the guest and removes its
temporary files. It does not use public networking or change firewall rules.
USAGE
}

case "\${1:-}" in
  --help|-h) usage; exit 0 ;;
  "") ;;
  *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
esac

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$*"; }
note() { printf 'INFO: %s\n' "$*"; }

[[ "$EUID" -eq 0 ]] || fail "Run this live host test as root so it can use qemu:///system and clean up the temporary guest."
ROOT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd)"
IMAGE_DIR="\${BHAI_IMAGE_DIR:-/var/lib/bhai-garage/images}"
VM_DIR="\${BHAI_VM_DIR:-/var/lib/bhai-garage/vms}"
AGENT_UID="\${BHAI_AGENT_UID:-1000}"
AGENT_GID="\${BHAI_AGENT_GID:-1000}"
IMAGE_FILE="noble-server-cloudimg-amd64.img"

[[ "$AGENT_UID" =~ ^[0-9]+$ && "$AGENT_GID" =~ ^[0-9]+$ ]] ||
  fail "BHAI_AGENT_UID and BHAI_AGENT_GID must be numeric."

for tool in virsh qemu-img cloud-localds realpath grep head cut tr xargs seq; do
  command -v "$tool" >/dev/null 2>&1 || fail "Required command is missing: $tool"
done

# Reuse the same authenticated image and host/network/storage preflight as the
# actual host agent. This test never changes libvirt networking or host firewall.
bash "$ROOT_DIR/scripts/prepare-kvm-host.sh" --check
IMAGE_DIR="$(realpath -e -- "$IMAGE_DIR")"
VM_DIR="$(realpath -e -- "$VM_DIR")"
IMAGE_PATH="$IMAGE_DIR/$IMAGE_FILE"
[[ -f "$IMAGE_PATH" ]] || fail "Verified Ubuntu cloud image is missing: $IMAGE_PATH"

token="$(tr -d '-' < /proc/sys/kernel/random/uuid | cut -c1-12)"
DOMAIN="bhai-garage-smoke-$token"
if virsh --connect qemu:///system list --all --name | grep -Fxq "$DOMAIN"; then
  fail "Generated test domain name already exists; refusing to touch it: $DOMAIN"
fi

TEMP_DIR="$(mktemp -d "$VM_DIR/.kvm-smoke.XXXXXXXX")"
disk_path="$TEMP_DIR/root.qcow2"
seed_path="$TEMP_DIR/cloud-init.iso"
user_data_path="$TEMP_DIR/user-data"
meta_data_path="$TEMP_DIR/meta-data"
domain_xml_path="$TEMP_DIR/domain.xml"

cleanup() {
  local original_status=$?
  local cleanup_status=0
  trap - EXIT
  set +e

  if virsh --connect qemu:///system list --all --name 2>/dev/null | grep -Fxq "$DOMAIN"; then
    local state
    state="$(virsh --connect qemu:///system domstate "$DOMAIN" 2>/dev/null | tr '[:upper:]' '[:lower:]' | xargs)"
    if [[ "$state" != "shut off" && "$state" != "shutoff" && "$state" != "crashed" ]]; then
      virsh --connect qemu:///system destroy "$DOMAIN" >/dev/null 2>&1
      local stop_status=$?
      if [[ "$stop_status" -ne 0 ]]; then
        state="$(virsh --connect qemu:///system domstate "$DOMAIN" 2>/dev/null | tr '[:upper:]' '[:lower:]' | xargs)"
        [[ "$state" == "shut off" || "$state" == "shutoff" || "$state" == "crashed" ]] || cleanup_status=1
      fi
    fi

    if [[ "$cleanup_status" -eq 0 ]]; then
      virsh --connect qemu:///system undefine "$DOMAIN" --nvram >/dev/null 2>&1 ||
        virsh --connect qemu:///system undefine "$DOMAIN" >/dev/null 2>&1
      if virsh --connect qemu:///system list --all --name 2>/dev/null | grep -Fxq "$DOMAIN"; then
        cleanup_status=1
      fi
    fi
  fi

  if [[ "$cleanup_status" -eq 0 ]]; then
    rm -rf -- "$TEMP_DIR"
  else
    printf 'ERROR: Could not fully remove temporary domain %s; preserving files at %s for manual recovery.\n' "$DOMAIN" "$TEMP_DIR" >&2
  fi

  if [[ "$original_status" -eq 0 && "$cleanup_status" -ne 0 ]]; then
    original_status=1
  fi
  exit "$original_status"
}
trap cleanup EXIT
chmod 0750 "$TEMP_DIR"
chown "$AGENT_UID:$AGENT_GID" "$TEMP_DIR"

qemu-img create -f qcow2 -F qcow2 -b "$IMAGE_PATH" "$disk_path" 8G
cat > "$user_data_path" <<'USERDATA'
#cloud-config
ssh_pwauth: false
disable_root: true
USERDATA
cat > "$meta_data_path" <<METADATA
instance-id: $DOMAIN
local-hostname: $DOMAIN
METADATA
cloud-localds "$seed_path" "$user_data_path" "$meta_data_path"
chmod 0640 "$disk_path" "$seed_path" "$user_data_path" "$meta_data_path"

xml_escape() {
  local value="$1"
  value="${value//&/\&amp;}"
  value="${value//</\&lt;}"
  value="${value//>/\&gt;}"
  value="${value//\"/\&quot;}"
  value="${value//\'/\&apos;}"
  printf '%s' "$value"
}

escaped_disk="$(xml_escape "$disk_path")"
escaped_seed="$(xml_escape "$seed_path")"
cat > "$domain_xml_path" <<XML
<domain type='kvm'>
  <name>$DOMAIN</name>
  <memory unit='MiB'>1024</memory>
  <currentMemory unit='MiB'>1024</currentMemory>
  <vcpu placement='static'>1</vcpu>
  <os><type arch='x86_64' machine='q35'>hvm</type><boot dev='hd'/></os>
  <features><acpi/><apic/></features>
  <cpu mode='host-passthrough' check='none'/>
  <clock offset='utc'/>
  <on_poweroff>destroy</on_poweroff><on_reboot>restart</on_reboot><on_crash>destroy</on_crash>
  <devices>
    <disk type='file' device='disk'><driver name='qemu' type='qcow2' cache='none' discard='unmap'/><source file='$escaped_disk'/><target dev='vda' bus='virtio'/></disk>
    <disk type='file' device='cdrom'><driver name='qemu' type='raw'/><source file='$escaped_seed'/><target dev='sda' bus='sata'/><readonly/></disk>
    <interface type='network'><source network='default'/><model type='virtio'/></interface>
    <console type='pty'><target type='serial' port='0'/></console>
  </devices>
</domain>
XML
chmod 0640 "$domain_xml_path"

virsh --connect qemu:///system define "$domain_xml_path" >/dev/null
virsh --connect qemu:///system start "$DOMAIN" >/dev/null
note "Temporary guest $DOMAIN started; waiting up to five minutes for a default-NAT DHCP lease."

guest_ip=""
for attempt in $(seq 1 150); do
  state="$(virsh --connect qemu:///system domstate "$DOMAIN" 2>/dev/null | tr '[:upper:]' '[:lower:]' | xargs || true)"
  [[ "$state" != "shut off" && "$state" != "shutoff" && "$state" != "crashed" ]] ||
    fail "Temporary KVM guest stopped before obtaining a DHCP lease (state: $state)."

  lease_output="$(virsh --connect qemu:///system domifaddr "$DOMAIN" --source lease 2>/dev/null || true)"
  lease_cidr="$(grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}' <<<"$lease_output" | head -n 1 || true)"
  if [[ -n "$lease_cidr" ]]; then
    guest_ip="\${lease_cidr%%/*}"
    break
  fi
  sleep 2
done

[[ -n "$guest_ip" ]] || fail "Guest did not receive a DHCP lease from libvirt's default NAT network within five minutes."
pass "Real x86-64 KVM guest reached running state and received private NAT IP $guest_ip."
note "The EXIT cleanup will now undefine $DOMAIN and remove its temporary disk/configuration."
