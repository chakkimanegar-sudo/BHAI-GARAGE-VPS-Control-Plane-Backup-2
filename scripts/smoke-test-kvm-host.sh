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

case "${1:-}" in
  --help|-h) usage; exit 0 ;;
  "") ;;
  *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
esac

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$*"; }
note() { printf 'INFO: %s\n' "$*"; }

[[ "$EUID" -eq 0 ]] || fail "Run this live host test as root so it can use qemu:///system and clean up the temporary guest."
ROOT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd)"
IMAGE_DIR="${BHAI_IMAGE_DIR:-/var/lib/libvirt/images/bhai-garage-base}"
VM_DIR="${BHAI_VM_DIR:-/var/lib/libvirt/images/bhai-garage-vms}"
AGENT_UID="${BHAI_AGENT_UID:-1000}"
AGENT_GID="${BHAI_AGENT_GID:-1000}"
QEMU_GID="${BHAI_QEMU_GID:-}"
IMAGE_FILE="noble-server-cloudimg-amd64.img"

[[ "$AGENT_UID" =~ ^[0-9]+$ && "$AGENT_GID" =~ ^[0-9]+$ ]] ||
  fail "BHAI_AGENT_UID and BHAI_AGENT_GID must be numeric."
if [[ -z "$QEMU_GID" ]]; then
  QEMU_GID="$(getent group libvirt-qemu | cut -d: -f3)"
fi
[[ "$QEMU_GID" =~ ^[0-9]+$ ]] || fail "Set BHAI_QEMU_GID to the numeric libvirt-qemu group ID."

for tool in virsh qemu-img cloud-localds realpath grep head cut tr xargs seq ssh ssh-keygen timeout; do
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
existing_domains="$(virsh --connect qemu:///system list --all --name)" ||
  fail "Cannot query libvirt domains; refusing to create a smoke-test guest."
if grep -Fxq "$DOMAIN" <<<"$existing_domains"; then
  fail "Generated test domain name already exists; refusing to touch it: $DOMAIN"
fi

TEMP_DIR="$(mktemp -d "$VM_DIR/.kvm-smoke.XXXXXXXX")"
LIFECYCLE_COMPLETE=0
# Match production: the setgid folder assigns the libvirt-qemu group to created files.
chown "$AGENT_UID:$QEMU_GID" "$TEMP_DIR"
chmod 2710 "$TEMP_DIR"
disk_path="$TEMP_DIR/root.qcow2"
seed_path="$TEMP_DIR/cloud-init.iso"
user_data_path="$TEMP_DIR/user-data"
meta_data_path="$TEMP_DIR/meta-data"
ssh_key_path="$TEMP_DIR/id_ed25519"
domain_xml_path="$TEMP_DIR/domain.xml"

cleanup() {
  local original_status=$?
  local cleanup_status=0
  local domain_list state list_status stop_status
  trap - EXIT
  set +e

  domain_list="$(virsh --connect qemu:///system list --all --name 2>/dev/null)"
  list_status=$?
  if [[ "$list_status" -ne 0 ]]; then
    cleanup_status=1
    printf 'ERROR: Cannot confirm libvirt domain state; preserving temporary files at %s.\n' "$TEMP_DIR" >&2
  elif grep -Fxq "$DOMAIN" <<<"$domain_list"; then
    if ! state="$(virsh --connect qemu:///system domstate "$DOMAIN" 2>/dev/null)"; then
      cleanup_status=1
    else
      state="$(tr '[:upper:]' '[:lower:]' <<<"$state" | xargs)"
      if [[ "$state" != "shut off" && "$state" != "shutoff" && "$state" != "crashed" ]]; then
        virsh --connect qemu:///system destroy "$DOMAIN" >/dev/null 2>&1
        stop_status=$?
        if [[ "$stop_status" -ne 0 ]]; then
          if ! state="$(virsh --connect qemu:///system domstate "$DOMAIN" 2>/dev/null)"; then
            cleanup_status=1
          else
            state="$(tr '[:upper:]' '[:lower:]' <<<"$state" | xargs)"
            [[ "$state" == "shut off" || "$state" == "shutoff" || "$state" == "crashed" ]] || cleanup_status=1
          fi
        fi
      fi

      if [[ "$cleanup_status" -eq 0 ]]; then
        if ! virsh --connect qemu:///system undefine "$DOMAIN" --nvram >/dev/null 2>&1; then
          virsh --connect qemu:///system undefine "$DOMAIN" >/dev/null 2>&1
          [[ "$?" -eq 0 ]] || cleanup_status=1
        fi
        domain_list="$(virsh --connect qemu:///system list --all --name 2>/dev/null)"
        list_status=$?
        if [[ "$list_status" -ne 0 ]] || grep -Fxq "$DOMAIN" <<<"$domain_list"; then
          cleanup_status=1
        fi
      fi
    fi
  fi

  if [[ "$cleanup_status" -eq 0 ]]; then
    rm -rf -- "$TEMP_DIR"
    if [[ "$original_status" -eq 0 && "$LIFECYCLE_COMPLETE" -eq 1 && ! -e "$TEMP_DIR" ]]; then
      pass "Temporary VM storage and ephemeral SSH key deleted."
    fi
  else
    printf 'ERROR: Could not fully clean up temporary domain %s; preserving files at %s for manual recovery.\n' "$DOMAIN" "$TEMP_DIR" >&2
  fi

  if [[ "$original_status" -eq 0 && "$cleanup_status" -ne 0 ]]; then
    original_status=1
  fi
  exit "$original_status"
}
trap cleanup EXIT
# Let system QEMU traverse the private temporary directory; no listing/writing.
chmod 0711 "$TEMP_DIR"
chown "$AGENT_UID:$AGENT_GID" "$TEMP_DIR"

qemu-img create -f qcow2 -F qcow2 -b "$IMAGE_PATH" "$disk_path" 8G
chown "$AGENT_UID:$QEMU_GID" "$disk_path"
chmod 0660 "$disk_path"
ssh-keygen -q -t ed25519 -N "" -f "$ssh_key_path" -C "$DOMAIN-smoke-test"
ssh_public_key="$(cat "$ssh_key_path.pub")"
cat > "$user_data_path" <<USERDATA
#cloud-config
users:
  - default
  - name: ubuntu
    lock_passwd: true
    ssh_authorized_keys:
      - $ssh_public_key
ssh_pwauth: false
disable_root: true
USERDATA
cat > "$meta_data_path" <<METADATA
instance-id: $DOMAIN
local-hostname: $DOMAIN
METADATA
cloud-localds "$seed_path" "$user_data_path" "$meta_data_path"
chown "$AGENT_UID:$QEMU_GID" "$seed_path"
chmod 0640 "$seed_path"
chmod 0600 "$user_data_path" "$meta_data_path"

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

wait_for_guest_ssh() {
  local phase="$1"
  local state lease_output lease_cidr guest_ip deadline
  guest_ip=""
  deadline=$((SECONDS + 300))
  note "$phase: waiting for a DHCP lease and reachable SSH (up to five minutes)."
  while (( SECONDS < deadline )); do
    state="$(virsh --connect qemu:///system domstate "$DOMAIN" 2>/dev/null | tr '[:upper:]' '[:lower:]' | xargs || true)"
    [[ "$state" != "shut off" && "$state" != "shutoff" && "$state" != "crashed" ]] ||
      fail "$DOMAIN stopped during $phase before guest reachability (state: $state)."

    lease_output="$(virsh --connect qemu:///system domifaddr "$DOMAIN" --source lease 2>/dev/null || true)"
    lease_cidr="$(grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}' <<<"$lease_output" | head -n 1 || true)"
    if [[ -n "$lease_cidr" ]]; then
      guest_ip="${lease_cidr%%/*}"
      if ssh -q -i "$ssh_key_path" -o BatchMode=yes -o ConnectTimeout=2 \
        -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        "ubuntu@$guest_ip" true >/dev/null 2>&1; then
        GUEST_IP="$guest_ip"
        pass "$phase: guest SSH is reachable at private NAT IP $GUEST_IP."
        return 0
      fi
    fi
    sleep 2
  done
  fail "$DOMAIN did not become SSH-reachable on libvirt NAT during $phase."
}

wait_for_cloud_init() {
  local phase="$1"
  local status_log="$TEMP_DIR/cloud-init-status-${phase//[^A-Za-z0-9]/-}.log"
  note "$phase: waiting for cloud-init to finish inside Ubuntu."
  if ! timeout 240 ssh -q -i "$ssh_key_path" -o BatchMode=yes -o ConnectTimeout=5 \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      "ubuntu@$GUEST_IP" 'sudo -n cloud-init status --wait --long' >"$status_log" 2>&1; then
    cat "$status_log" >&2
    fail "Guest cloud-init did not complete successfully during $phase."
  fi
  if ! grep -Eq 'status:[[:space:]]*done' "$status_log"; then
    cat "$status_log" >&2
    fail "Guest cloud-init did not report status: done during $phase."
  fi
  pass "$phase: cloud-init status is done."
}

wait_for_guest_ready() {
  wait_for_guest_ssh "$1"
  wait_for_cloud_init "$1"
}

wait_for_domain_stopped() {
  local state
  for attempt in $(seq 1 30); do
    state="$(virsh --connect qemu:///system domstate "$DOMAIN" 2>/dev/null | tr '[:upper:]' '[:lower:]' | xargs || true)"
    if [[ "$state" == "shut off" || "$state" == "shutoff" ]]; then
      pass "$DOMAIN reached shut-off state."
      return 0
    fi
    sleep 2
  done
  fail "$DOMAIN did not shut down cleanly within 60 seconds."
}

virsh --connect qemu:///system define "$domain_xml_path" >/dev/null
virsh --connect qemu:///system start "$DOMAIN" >/dev/null
wait_for_guest_ready "initial boot"

virsh --connect qemu:///system shutdown "$DOMAIN" >/dev/null
wait_for_domain_stopped
pass "Guest stop lifecycle succeeded."

virsh --connect qemu:///system start "$DOMAIN" >/dev/null
wait_for_guest_ready "start after stop"
pass "Guest start lifecycle succeeded after a clean shutdown."

virsh --connect qemu:///system shutdown "$DOMAIN" >/dev/null
wait_for_domain_stopped
virsh --connect qemu:///system undefine "$DOMAIN" --nvram >/dev/null 2>&1 ||
  virsh --connect qemu:///system undefine "$DOMAIN" >/dev/null
if virsh --connect qemu:///system list --all --name | grep -Fxq "$DOMAIN"; then
  fail "Temporary domain still exists after undefine: $DOMAIN"
fi
LIFECYCLE_COMPLETE=1
pass "Guest delete lifecycle succeeded: domain undefined; cleanup will verify disk/key removal."
