#!/usr/bin/env bash
set -Eeuo pipefail

readonly IMAGE_FILE="noble-server-cloudimg-amd64.img"
readonly IMAGE_URL="https://cloud-images.ubuntu.com/releases/noble/release"
readonly LIBVIRT_IMAGE_ROOT="/var/lib/libvirt/images"

MODE="check"
case "${1:---check}" in
  --check) MODE="check" ;;
  --install) MODE="install" ;;
  --help|-h)
    cat <<'USAGE'
Prepare an Ubuntu 24.04 x86-64 machine as a BHAI GARAGE KVM host.

Usage:
  sudo bash scripts/prepare-kvm-host.sh --check
  sudo bash scripts/prepare-kvm-host.sh --install

--check    Read-only preflight; does not install packages or alter networking.
--install  Install KVM/libvirt tools, activate libvirt's default NAT network,
           and download/verify the official Ubuntu 24.04 AMD64 cloud image.

This does NOT configure public/routed IPs for individual guests or change the
host firewall. Provider-specific guest ingress requires a separate network plan.
USAGE
    exit 0
    ;;
  *)
    printf 'Unknown option: %s\n' "$1" >&2
    exit 2
    ;;
esac

if [[ $# -gt 1 ]]; then
  echo "Pass exactly one option: --check, --install, or --help." >&2
  exit 2
fi

TEST_ROOT="${BHAI_KVM_HOST_TEST_ROOT:-}"
if [[ -n "$TEST_ROOT" ]]; then
  if [[ "$MODE" != "check" || ! -d "$TEST_ROOT" ]]; then
    echo "BHAI_KVM_HOST_TEST_ROOT is only supported for read-only tests." >&2
    exit 2
  fi
fi

host_path() {
  local value="$1"
  if [[ -n "$TEST_ROOT" ]]; then
    printf '%s%s' "${TEST_ROOT%/}" "$value"
  else
    printf '%s' "$value"
  fi
}

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

note() {
  printf 'INFO: %s\n' "$*"
}

pass() {
  printf 'PASS: %s\n' "$*"
}

resolve_qemu_gid() {
  local gid="${BHAI_QEMU_GID:-}"
  if [[ -z "$gid" ]]; then
    gid="$(getent group libvirt-qemu | cut -d: -f3)"
  fi
  [[ "$gid" =~ ^[0-9]+$ ]] || fail "Unable to resolve numeric libvirt-qemu GID; set BHAI_QEMU_GID."
  printf '%s' "$gid"
}

fetch_verified_manifest() {
  local temp_dir="$1"
  for file in SHA256SUMS SHA256SUMS.gpg; do
    curl --fail --location --retry 3 --connect-timeout 15 --max-time 120 \
      --silent --show-error "$IMAGE_URL/$file" --output "$temp_dir/$file"
  done

  local keyring="/usr/share/keyrings/ubuntu-cloudimage-keyring.gpg"
  [[ -s "$keyring" ]] || keyring="/etc/apt/trusted.gpg.d/ubuntu-keyring-2012-cdimage.gpg"
  [[ -s "$keyring" ]] || fail "Ubuntu cloud-image signing keyring is missing."

  gpgv --keyring "$keyring" "$temp_dir/SHA256SUMS.gpg" "$temp_dir/SHA256SUMS"
  grep -Fq "  $IMAGE_FILE" "$temp_dir/SHA256SUMS" ||
    fail "Official SHA256SUMS has no entry for $IMAGE_FILE."
}

verify_image_checksum_record() {
  local image_dir="$1"
  local image_file="$2"
  local record="$3"
  [[ -f "$record" && ! -L "$record" ]] ||
    fail "Trusted cloud-image checksum record missing or unsafe: $record"

  local digest recorded_file extra
  read -r digest recorded_file extra < "$record" ||
    fail "Cloud-image checksum record is empty: $record"
  [[ "$digest" =~ ^[[:xdigit:]]{64}$ && "$recorded_file" == "$image_file" && -z "${extra:-}" ]] ||
    fail "Cloud-image checksum record has an invalid format: $record"

  local record_path
  record_path="$(realpath -- "$record")" || fail "Cannot resolve cloud-image checksum record: $record"
  (cd "$image_dir" && sha256sum --check --status "$record_path") ||
    fail "Cloud image checksum verification failed: $image_dir/$image_file"
}

write_image_checksum_record() {
  local image_dir="$1"
  local image_file="$2"
  local record="$3"
  local temp_record="$4"
  (cd "$image_dir" && sha256sum "$image_file") > "$temp_record"
  install -o root -g root -m 0444 "$temp_record" "$record"
}

IMAGE_DIR="${BHAI_IMAGE_DIR:-/var/lib/libvirt/images/bhai-garage-base}"
VM_DIR="${BHAI_VM_DIR:-/var/lib/libvirt/images/bhai-garage-vms}"
AGENT_UID="${BHAI_AGENT_UID:-1000}"
AGENT_GID="${BHAI_AGENT_GID:-1000}"
QEMU_GID="${BHAI_QEMU_GID:-}"
OS_RELEASE="$(host_path /etc/os-release)"
CPU_INFO="$(host_path /proc/cpuinfo)"
KVM_DEVICE="$(host_path /dev/kvm)"

[[ "$AGENT_UID" =~ ^[0-9]+$ && "$AGENT_GID" =~ ^[0-9]+$ ]] ||
  fail "BHAI_AGENT_UID and BHAI_AGENT_GID must be numeric."

# Keep all guest disks and their backing images inside libvirt's standard
# image tree. This is compatible with Ubuntu's default per-guest AppArmor path
# policy; a custom storage tree needs a separately reviewed AppArmor policy.
case "$IMAGE_DIR" in "$LIBVIRT_IMAGE_ROOT"/*) ;; *)
  fail "BHAI_IMAGE_DIR must be a child of $LIBVIRT_IMAGE_ROOT for the default libvirt AppArmor policy."
  ;;
esac
case "$VM_DIR" in "$LIBVIRT_IMAGE_ROOT"/*) ;; *)
  fail "BHAI_VM_DIR must be a child of $LIBVIRT_IMAGE_ROOT for the default libvirt AppArmor policy."
  ;;
esac
IMAGE_DIR_NAME="${IMAGE_DIR#"$LIBVIRT_IMAGE_ROOT"/}"
VM_DIR_NAME="${VM_DIR#"$LIBVIRT_IMAGE_ROOT"/}"
[[ -n "$IMAGE_DIR_NAME" && "$IMAGE_DIR_NAME" != */* ]] ||
  fail "BHAI_IMAGE_DIR must be a direct child of $LIBVIRT_IMAGE_ROOT."
[[ -n "$VM_DIR_NAME" && "$VM_DIR_NAME" != */* ]] ||
  fail "BHAI_VM_DIR must be a direct child of $LIBVIRT_IMAGE_ROOT."
LIBVIRT_ROOT_CONFIG_PATH="$(host_path "$LIBVIRT_IMAGE_ROOT")"
IMAGE_DIR_CONFIG_PATH="$(host_path "$IMAGE_DIR")"
VM_DIR_CONFIG_PATH="$(host_path "$VM_DIR")"
[[ ! -L "$LIBVIRT_ROOT_CONFIG_PATH" && ! -L "$IMAGE_DIR_CONFIG_PATH" && ! -L "$VM_DIR_CONFIG_PATH" ]] ||
  fail "Libvirt image root, BHAI_IMAGE_DIR, and BHAI_VM_DIR must not be symlinks."

[[ -r "$OS_RELEASE" ]] || fail "Cannot read /etc/os-release."
# shellcheck disable=SC1090
. "$OS_RELEASE"
[[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]] ||
  fail "Use Ubuntu Server 24.04 LTS on the physical host. Detected ${PRETTY_NAME:-unknown OS}."
[[ "$(uname -m)" == "x86_64" ]] ||
  fail "This host needs the x86_64/AMD64 architecture."

[[ -r "$CPU_INFO" ]] || fail "Cannot read CPU capabilities."
grep -Eiq '(^|[[:space:]])(vmx|svm)([[:space:]]|$)' "$CPU_INFO" ||
  fail "CPU virtualization flags (Intel VT-x/AMD-V) are not exposed."
[[ -e "$KVM_DEVICE" ]] ||
  fail "/dev/kvm is missing. Rent bare metal or ask the provider to expose KVM hardware virtualization."
pass "Ubuntu 24.04 x86_64 host exposes CPU virtualization and /dev/kvm."

if [[ "$MODE" == "install" ]]; then
  [[ -z "$TEST_ROOT" ]] || fail "Install mode is disabled when a test root is set."
  [[ "$EUID" -eq 0 ]] || fail "Run --install as root (for example, sudo bash scripts/prepare-kvm-host.sh --install)."
  command -v apt-get >/dev/null 2>&1 || fail "apt-get is required."
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    ca-certificates curl gpgv ubuntu-keyring ubuntu-cloudimage-keyring \
    qemu-kvm libvirt-daemon-system libvirt-clients qemu-utils cloud-image-utils

  QEMU_GID="$(resolve_qemu_gid)"
  systemctl enable --now libvirtd

  if ! virsh --connect qemu:///system net-list --all --name | grep -Fxq default; then
    [[ -r /usr/share/libvirt/networks/default.xml ]] ||
      fail "libvirt default network XML is missing; refusing to invent provider-specific networking."
    virsh --connect qemu:///system net-define /usr/share/libvirt/networks/default.xml
  fi
  if ! virsh --connect qemu:///system net-info default | grep -Eq '^[[:space:]]*Active:[[:space:]]+yes'; then
    virsh --connect qemu:///system net-start default
  fi
  virsh --connect qemu:///system net-autostart default

  QEMU_GID="$(resolve_qemu_gid)"
  install -d -o root -g root -m 0755 "$IMAGE_DIR"
  if [[ -e "$VM_DIR" ]]; then
    [[ -d "$VM_DIR" && ! -L "$VM_DIR" ]] || fail "VM storage path must be a real directory, not a symlink: $VM_DIR"
    existing_entries="$(find "$VM_DIR" -mindepth 1 -maxdepth 1 -print -quit)"
    existing_owner="$(stat -c %u "$VM_DIR")"
    if [[ -n "$existing_entries" && "$existing_owner" != "$AGENT_UID" ]]; then
      fail "Existing VM storage is non-empty and owned by another UID. Refusing to change ownership automatically: $VM_DIR"
    fi
  fi
  install -d -o "$AGENT_UID" -g "$QEMU_GID" -m 2710 "$VM_DIR"
  chown "$AGENT_UID:$QEMU_GID" "$VM_DIR"
  chmod 2710 "$VM_DIR"

  # Repair metadata on managed guests only; disk contents are not rewritten.
  while IFS= read -r -d '' instance_dir; do
    [[ ! -L "$instance_dir" && -d "$instance_dir" ]] ||
      fail "Managed VPS path is not a real directory: $instance_dir"
    instance_owner="$(stat -c '%u' "$instance_dir")"
    [[ "$instance_owner" == "$AGENT_UID" ]] ||
      fail "Managed VPS directory is not owned by UID $AGENT_UID; refusing automatic repair: $instance_dir"
    chown "$AGENT_UID:$QEMU_GID" "$instance_dir"
    chmod 2710 "$instance_dir"
    disk_path="$instance_dir/root.qcow2"
    if [[ -e "$disk_path" ]]; then
      [[ -f "$disk_path" && ! -L "$disk_path" ]] ||
        fail "Managed VPS disk is not a regular file; refusing permission change: $disk_path"
      chown "$AGENT_UID:$QEMU_GID" "$disk_path"
      chmod 0660 "$disk_path"
    fi
    seed_path="$instance_dir/cloud-init.iso"
    if [[ -e "$seed_path" ]]; then
      [[ -f "$seed_path" && ! -L "$seed_path" ]] ||
        fail "Managed cloud-init ISO is not a regular file: $seed_path"
      chown "$AGENT_UID:$QEMU_GID" "$seed_path"
      chmod 0640 "$seed_path"
    fi
  done < <(find "$VM_DIR" -mindepth 1 -maxdepth 1 -type d -name 'bg-*' -print0)

  IMAGE_PATH="$IMAGE_DIR/$IMAGE_FILE"
  CHECKSUM_PATH="$IMAGE_PATH.sha256"
  if [[ -e "$IMAGE_PATH" ]]; then
    qemu-img info --output=json "$IMAGE_PATH" | grep -Eq '"format"[[:space:]]*:[[:space:]]*"qcow2"' ||
      fail "Existing image path is not a valid QCOW2 file: $IMAGE_PATH"

    if [[ -f "$CHECKSUM_PATH" ]]; then
      # The record is created root-owned only after the image matches Canonical's
      # signed release manifest; recheck it before every host preflight.
      verify_image_checksum_record "$IMAGE_DIR" "$IMAGE_FILE" "$CHECKSUM_PATH"
    else
      # Migrate an image installed by an older version only if it still matches
      # the current Canonical-signed manifest. Never bless an unverified cache.
      temp_dir="$(mktemp -d)"
      trap 'rm -rf -- "$temp_dir"' EXIT
      fetch_verified_manifest "$temp_dir"
      checksum_output="$(cd "$IMAGE_DIR" && sha256sum --check --ignore-missing "$temp_dir/SHA256SUMS")"
      printf '%s\n' "$checksum_output" | grep -Fxq "$IMAGE_FILE: OK" ||
        fail "Existing cloud image has no trusted checksum record and does not match the signed current release; preserve any VM disks and investigate before replacing it."
      write_image_checksum_record "$IMAGE_DIR" "$IMAGE_FILE" "$CHECKSUM_PATH" "$temp_dir/image.sha256"
      rm -rf -- "$temp_dir"
      trap - EXIT
    fi
  else
    temp_dir="$(mktemp -d)"
    trap 'rm -rf -- "$temp_dir"' EXIT
    fetch_verified_manifest "$temp_dir"
    curl --fail --location --retry 3 --connect-timeout 15 --max-time 900 \
      --silent --show-error "$IMAGE_URL/$IMAGE_FILE" --output "$temp_dir/$IMAGE_FILE"
    checksum_output="$(cd "$temp_dir" && sha256sum --check --ignore-missing SHA256SUMS)"
    printf '%s\n' "$checksum_output" | grep -Fxq "$IMAGE_FILE: OK" ||
      fail "Ubuntu cloud image did not match Canonical's signed SHA-256 checksum."

    install -o root -g root -m 0644 "$temp_dir/$IMAGE_FILE" "$IMAGE_PATH"
    write_image_checksum_record "$IMAGE_DIR" "$IMAGE_FILE" "$CHECKSUM_PATH" "$temp_dir/image.sha256"
    rm -rf -- "$temp_dir"
    trap - EXIT
  fi
  pass "libvirt packages, default NAT network, storage, and signed Ubuntu image prepared."
fi

for tool in virsh qemu-img cloud-localds getent; do
  command -v "$tool" >/dev/null 2>&1 || fail "Required command is missing: $tool (run --install)."
done
QEMU_GID="$(resolve_qemu_gid)"

virsh_uri="$(virsh --connect qemu:///system uri)" ||
  fail "Cannot connect to the local qemu:///system libvirt instance."
[[ "$virsh_uri" == "qemu:///system" ]] || fail "Unexpected libvirt URI: $virsh_uri."
capabilities="$(virsh --connect qemu:///system capabilities)" ||
  fail "Unable to query libvirt host capabilities."
grep -Fq '<arch>x86_64</arch>' <<<"$capabilities" ||
  fail "Libvirt does not report an x86_64 host."
grep -Eq "domain type=['\"]kvm['\"]" <<<"$capabilities" ||
  fail "Libvirt does not report a KVM-capable x86_64 guest domain."
network_info="$(virsh --connect qemu:///system net-info default)" ||
  fail "The libvirt default network is not defined."
grep -Eq '^[[:space:]]*Active:[[:space:]]+yes' <<<"$network_info" ||
  fail "The libvirt default network is not active."
network_xml="$(virsh --connect qemu:///system net-dumpxml default)" ||
  fail "Unable to inspect the libvirt default network."
grep -Eq "mode=.?nat" <<<"$network_xml" ||
  fail "The default libvirt network is not configured for NAT; refusing to assume guest connectivity."
pass "libvirt KVM guest support and active default NAT network verified."

IMAGE_PATH="$(host_path "$IMAGE_DIR")/$IMAGE_FILE"
CHECKSUM_PATH="$IMAGE_PATH.sha256"
[[ -d "$(host_path "$IMAGE_DIR")" ]] || fail "Image directory missing: $IMAGE_DIR"
[[ -r "$IMAGE_PATH" ]] || fail "Verified cloud image missing: $IMAGE_PATH (run --install)."
verify_image_checksum_record "$(dirname "$IMAGE_PATH")" "$IMAGE_FILE" "$CHECKSUM_PATH"
image_metadata="$(qemu-img info --output=json "$IMAGE_PATH")" ||
  fail "qemu-img cannot read the Ubuntu cloud image."
grep -Eq '"format"[[:space:]]*:[[:space:]]*"qcow2"' <<<"$image_metadata" ||
  fail "The configured Ubuntu cloud image is not QCOW2."
LIBVIRT_ROOT_PATH="$(host_path "$LIBVIRT_IMAGE_ROOT")"
IMAGE_DIR_PATH="$(host_path "$IMAGE_DIR")"
VM_PATH="$(host_path "$VM_DIR")"
[[ -d "$LIBVIRT_ROOT_PATH" ]] || fail "Standard libvirt image root is missing: $LIBVIRT_IMAGE_ROOT"
[[ -d "$IMAGE_DIR_PATH" && -d "$VM_PATH" && -w "$VM_PATH" ]] ||
  fail "VM storage or cloud-image directory is missing/not writable: $IMAGE_DIR / $VM_DIR"
libvirt_root_real="$(realpath -e -- "$LIBVIRT_ROOT_PATH")"
image_dir_real="$(realpath -e -- "$IMAGE_DIR_PATH")"
vm_dir_real="$(realpath -e -- "$VM_PATH")"
[[ "$image_dir_real" == "$libvirt_root_real/"* ]] ||
  fail "Cloud-image directory resolves outside libvirt's standard image root: $IMAGE_DIR"
[[ "$vm_dir_real" == "$libvirt_root_real/"* ]] ||
  fail "VM storage resolves outside libvirt's standard image root: $VM_DIR"
vm_owner="$(stat -c '%u' "$VM_PATH")"
vm_group="$(stat -c '%g' "$VM_PATH")"
vm_mode="$(stat -c '%a' "$VM_PATH")"
[[ "$vm_owner" == "$AGENT_UID" ]] ||
  fail "VM storage owner UID is $vm_owner; Docker host-agent runs as UID $AGENT_UID. Run --install or fix ownership."
[[ "$vm_group" == "$QEMU_GID" && "$vm_mode" == "2710" ]] ||
  fail "VM storage must be owned by agent UID $AGENT_UID, group libvirt-qemu GID $QEMU_GID, and mode 2710. Run --install."
while IFS= read -r -d '' instance_dir; do
  [[ ! -L "$instance_dir" && -d "$instance_dir" ]] ||
    fail "Managed VPS path must be a real directory: $instance_dir"
  instance_owner="$(stat -c '%u' "$instance_dir")"
  instance_group="$(stat -c '%g' "$instance_dir")"
  instance_mode="$(stat -c '%a' "$instance_dir")"
  [[ "$instance_owner" == "$AGENT_UID" && "$instance_group" == "$QEMU_GID" && "$instance_mode" == "2710" ]] ||
    fail "Existing VPS directory must use agent UID $AGENT_UID, QEMU GID $QEMU_GID, mode 2710: $instance_dir. Run --install."
  if [[ -e "$instance_dir/root.qcow2" ]]; then
    [[ -f "$instance_dir/root.qcow2" && ! -L "$instance_dir/root.qcow2" ]] ||
      fail "Managed VPS disk must be a regular file: $instance_dir/root.qcow2"
    disk_mode="$(stat -c '%a' "$instance_dir/root.qcow2")"
    disk_group="$(stat -c '%g' "$instance_dir/root.qcow2")"
    [[ "$disk_group" == "$QEMU_GID" && "$disk_mode" == "660" ]] ||
      fail "Managed VPS disk must use QEMU GID $QEMU_GID and mode 660: $instance_dir/root.qcow2. Run --install."
  fi
  if [[ -e "$instance_dir/cloud-init.iso" ]]; then
    [[ -f "$instance_dir/cloud-init.iso" && ! -L "$instance_dir/cloud-init.iso" ]] ||
      fail "Managed cloud-init ISO must be a regular file: $instance_dir/cloud-init.iso"
    seed_mode="$(stat -c '%a' "$instance_dir/cloud-init.iso")"
    seed_group="$(stat -c '%g' "$instance_dir/cloud-init.iso")"
    [[ "$seed_group" == "$QEMU_GID" && "$seed_mode" == "640" ]] ||
      fail "Managed cloud-init ISO must use QEMU GID $QEMU_GID and mode 640: $instance_dir/cloud-init.iso. Run --install."
  fi
done < <(find "$VM_PATH" -mindepth 1 -maxdepth 1 -type d -name 'bg-*' -print0)
pass "Ubuntu QCOW2 integrity, QEMU group membership, and writable guest-disk permissions verified."
pass "cloud-localds is available for cloud-init SSH-key provisioning."

note "For Compose, map BHAI_IMAGE_DIR=$IMAGE_DIR and BHAI_VM_DIR=$VM_DIR."
note "Set BHAI_IMAGES_JSON to {\"ubuntu-24.04\":\"$IMAGE_DIR/$IMAGE_FILE\"}."
note "Set LIBVIRT_GID to the numeric group ID of the host's libvirt socket."
note "Set BHAI_QEMU_GID=$QEMU_GID (libvirt-qemu numeric GID) for guest disk read/write access."
note "This prepares guest outbound NAT only. It does not assign public IPs to guests or change firewall rules."
note "Before customer hosting, choose a provider-specific routed IP/bridge or an explicitly documented port-forwarding plan, then restrict SSH/API/guest ingress with the provider and host firewall."
pass "KVM host preflight passed. This verifies host prerequisites; it does not create a VPS."
