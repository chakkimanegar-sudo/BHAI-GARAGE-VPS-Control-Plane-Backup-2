#!/usr/bin/env bash
set -Eeuo pipefail

readonly IMAGE_ID="ubuntu-24.04"
readonly IMAGE_FILE="noble-server-cloudimg-amd64.img"
readonly IMAGE_URL="https://cloud-images.ubuntu.com/noble/current"
readonly CONTAINER_IMAGE_DIR="/var/lib/bhai-garage/images"
readonly CONTAINER_VM_DIR="/var/lib/bhai-garage/vms"

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

IMAGE_DIR="${BHAI_IMAGE_DIR:-/var/lib/bhai-garage/images}"
VM_DIR="${BHAI_VM_DIR:-/var/lib/bhai-garage/vms}"
AGENT_UID="${BHAI_AGENT_UID:-1000}"
AGENT_GID="${BHAI_AGENT_GID:-1000}"
OS_RELEASE="$(host_path /etc/os-release)"
CPU_INFO="$(host_path /proc/cpuinfo)"
KVM_DEVICE="$(host_path /dev/kvm)"

[[ "$AGENT_UID" =~ ^[0-9]+$ && "$AGENT_GID" =~ ^[0-9]+$ ]] ||
  fail "BHAI_AGENT_UID and BHAI_AGENT_GID must be numeric."

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
    ca-certificates curl gpgv ubuntu-keyring \
    qemu-kvm libvirt-daemon-system libvirt-clients qemu-utils cloud-image-utils

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

  install -d -o root -g root -m 0755 "$IMAGE_DIR"
  install -d -o "$AGENT_UID" -g "$AGENT_GID" -m 0750 "$VM_DIR"

  IMAGE_PATH="$IMAGE_DIR/$IMAGE_FILE"
  if [[ ! -e "$IMAGE_PATH" ]]; then
    temp_dir="$(mktemp -d)"
    trap 'rm -rf -- "$temp_dir"' EXIT
    for file in SHA256SUMS SHA256SUMS.gpg "$IMAGE_FILE"; do
      curl --fail --location --retry 3 --connect-timeout 15 --max-time 900 \
        --silent --show-error "$IMAGE_URL/$file" --output "$temp_dir/$file"
    done

    keyring="/usr/share/keyrings/ubuntu-cloudimage-keyring.gpg"
    [[ -s "$keyring" ]] || keyring="/etc/apt/trusted.gpg.d/ubuntu-keyring-2012-cdimage.gpg"
    [[ -s "$keyring" ]] || fail "Ubuntu cloud-image signing keyring is missing."

    gpgv --keyring "$keyring" "$temp_dir/SHA256SUMS.gpg" "$temp_dir/SHA256SUMS"
    grep -Fq "  $IMAGE_FILE" "$temp_dir/SHA256SUMS" ||
      fail "Official SHA256SUMS has no entry for $IMAGE_FILE."
    checksum_output="$(cd "$temp_dir" && sha256sum --check --ignore-missing SHA256SUMS)"
    printf '%s\n' "$checksum_output" | grep -Fxq "$IMAGE_FILE: OK" ||
      fail "Ubuntu cloud image did not match its signed SHA-256 checksum."

    install -o root -g root -m 0644 "$temp_dir/$IMAGE_FILE" "$IMAGE_PATH"
    rm -rf -- "$temp_dir"
    trap - EXIT
  else
    qemu-img info --output=json "$IMAGE_PATH" | grep -Eq '"format"[[:space:]]*:[[:space:]]*"qcow2"' ||
      fail "Existing image path is not a valid QCOW2 file: $IMAGE_PATH"
  fi
  pass "libvirt packages, default NAT network, storage, and signed Ubuntu image prepared."
fi

for tool in virsh qemu-img cloud-localds; do
  command -v "$tool" >/dev/null 2>&1 || fail "Required command is missing: $tool (run --install)."
done

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
pass "libvirt KVM guest support and active default network verified."

IMAGE_PATH="$(host_path "$IMAGE_DIR")/$IMAGE_FILE"
[[ -d "$(host_path "$IMAGE_DIR")" ]] || fail "Image directory missing: $IMAGE_DIR"
[[ -r "$IMAGE_PATH" ]] || fail "Verified cloud image missing: $IMAGE_PATH (run --install)."
image_metadata="$(qemu-img info --output=json "$IMAGE_PATH")" ||
  fail "qemu-img cannot read the Ubuntu cloud image."
grep -Eq '"format"[[:space:]]*:[[:space:]]*"qcow2"' <<<"$image_metadata" ||
  fail "The configured Ubuntu cloud image is not QCOW2."
VM_PATH="$(host_path "$VM_DIR")"
[[ -d "$VM_PATH" && -w "$VM_PATH" ]] || fail "VM storage is missing or not writable: $VM_DIR"
vm_owner="$(stat -c '%u' "$VM_PATH")"
[[ "$vm_owner" == "$AGENT_UID" ]] ||
  fail "VM storage owner UID is $vm_owner; Docker host-agent runs as UID $AGENT_UID. Run --install or fix ownership."
pass "Ubuntu QCOW2 image and writable VM storage verified."
pass "cloud-localds is available for cloud-init SSH-key provisioning."

note "For Compose, map BHAI_IMAGE_DIR=$IMAGE_DIR and BHAI_VM_DIR=$VM_DIR."
note "Set BHAI_IMAGES_JSON to {\"ubuntu-24.04\":\"$CONTAINER_IMAGE_DIR/$IMAGE_FILE\"}."
note "Set LIBVIRT_GID to the numeric group ID of the host's libvirt socket."
note "This prepares guest outbound NAT only. It does not assign public IPs to guests or change firewall rules."
note "Before customer hosting, choose a provider-specific routed IP/bridge or an explicitly documented port-forwarding plan, then restrict SSH/API/guest ingress with the provider and host firewall."
pass "KVM host preflight passed. This verifies host prerequisites; it does not create a VPS."
