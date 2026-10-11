#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
temporary_root="$(mktemp -d)"
trap 'rm -rf -- "$temporary_root"' EXIT

test_root="$temporary_root/host"
fake_bin="$temporary_root/bin"
image_dir="$test_root/var/lib/libvirt/images/bhai-garage-base"
vm_dir="$test_root/var/lib/libvirt/images/bhai-garage-vms"
mkdir -p "$fake_bin" "$image_dir" "$vm_dir" "$test_root/etc" "$test_root/proc" "$test_root/dev"
existing_vps_dir="$vm_dir/bg-00000000000040008000000000000002"
mkdir -p "$existing_vps_dir"
chmod 0750 "$vm_dir" "$existing_vps_dir"

cat > "$test_root/etc/os-release" <<'OS_RELEASE'
ID=ubuntu
VERSION_ID="24.04"
PRETTY_NAME="Ubuntu 24.04 LTS (test fixture)"
OS_RELEASE
printf 'processor flags : fpu vmx sse sse2\n' > "$test_root/proc/cpuinfo"
: > "$test_root/dev/kvm"
printf 'mock qcow2 image\n' > "$image_dir/noble-server-cloudimg-amd64.img"
(cd "$image_dir" && sha256sum "noble-server-cloudimg-amd64.img") > "$image_dir/noble-server-cloudimg-amd64.img.sha256"

cat > "$fake_bin/virsh" <<'FAKE_VIRSH'
#!/usr/bin/env bash
set -Eeuo pipefail
case "${3:-}" in
  uri) printf 'qemu:///system\n' ;;
  capabilities)
    printf "%s\n" "<capabilities><host><cpu><arch>x86_64</arch></cpu></host><guest><arch name='x86_64'><domain type='kvm'></domain></arch></guest></capabilities>"
    ;;
  net-info) printf 'Name: default\nActive: yes\n' ;;
  net-dumpxml) printf "%s\n" "<network><forward mode=\"nat\"/></network>" ;;
  *) echo "Unexpected virsh invocation: $*" >&2; exit 90 ;;
esac
FAKE_VIRSH

cat > "$fake_bin/qemu-img" <<'FAKE_QEMU'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '{"format":"qcow2"}\n'
FAKE_QEMU

cat > "$fake_bin/cloud-localds" <<'FAKE_CLOUD_LOCALDS'
#!/usr/bin/env bash
exit 0
FAKE_CLOUD_LOCALDS

chmod 700 "$fake_bin/"*
export PATH="$fake_bin:$PATH"
export BHAI_KVM_HOST_TEST_ROOT="$test_root"
export BHAI_IMAGE_DIR=/var/lib/libvirt/images/bhai-garage-base
export BHAI_VM_DIR=/var/lib/libvirt/images/bhai-garage-vms
export BHAI_AGENT_UID="$(id -u)"
export BHAI_AGENT_GID="$(id -g)"

# A closed 0750 storage directory must not be reported ready: system QEMU runs
# as libvirt-qemu and needs search-only access to the disk's parent directory.
if bash "$root/scripts/prepare-kvm-host.sh" --check >"$temporary_root/no-qemu-search.out" 2>&1; then
  echo "Host preflight unexpectedly accepted VM storage without QEMU search access." >&2
  exit 1
fi
grep -Fq 'must grant search-only access to libvirt-qemu' "$temporary_root/no-qemu-search.out"
chmod 0711 "$vm_dir"

# Existing per-VPS directories need the same traversal bit as their parent.
if bash "$root/scripts/prepare-kvm-host.sh" --check >"$temporary_root/no-vps-search.out" 2>&1; then
  echo "Host preflight unexpectedly accepted a VPS directory without QEMU search access." >&2
  exit 1
fi
grep -Fq 'Existing VM directory is not searchable by libvirt-qemu' "$temporary_root/no-vps-search.out"
chmod 0711 "$existing_vps_dir"

# A custom path outside libvirt's standard image tree is rejected rather than
# silently creating a guest that AppArmor cannot access.
if BHAI_VM_DIR=/var/lib/bhai-garage/vms bash "$root/scripts/prepare-kvm-host.sh" --check >"$temporary_root/custom-path.out" 2>&1; then
  echo "Host preflight unexpectedly accepted a custom VM directory outside libvirt's image tree." >&2
  exit 1
fi
grep -Fq 'BHAI_VM_DIR must be a child of /var/lib/libvirt/images' "$temporary_root/custom-path.out"

# Production provisioning must use the stable released image stream, not daily builds.
grep -Fq 'readonly IMAGE_URL="https://cloud-images.ubuntu.com/releases/noble/release"' "$root/scripts/prepare-kvm-host.sh"
if grep -Fq 'cloud-images.ubuntu.com/noble/current' "$root/scripts/prepare-kvm-host.sh"; then
  echo "KVM preparation unexpectedly uses the daily cloud image stream." >&2
  exit 1
fi

check_output="$(bash "$root/scripts/prepare-kvm-host.sh" --check)"
grep -Fq 'PASS: Ubuntu 24.04 x86_64 host exposes CPU virtualization and /dev/kvm.' <<<"$check_output"
grep -Fq 'PASS: libvirt KVM guest support and active default NAT network verified.' <<<"$check_output"
grep -Fq 'PASS: KVM host preflight passed.' <<<"$check_output"
grep -Fq 'does not assign public IPs to guests' <<<"$check_output"

# Host readiness must fail closed if the cached base image is modified.
cp "$image_dir/noble-server-cloudimg-amd64.img" "$temporary_root/original-image"
printf 'tampered image\n' > "$image_dir/noble-server-cloudimg-amd64.img"
if bash "$root/scripts/prepare-kvm-host.sh" --check >"$temporary_root/bad-checksum.out" 2>&1; then
  echo "Host preflight unexpectedly accepted a tampered cloud image." >&2
  exit 1
fi
grep -Fq 'Cloud image checksum verification failed' "$temporary_root/bad-checksum.out"
mv "$temporary_root/original-image" "$image_dir/noble-server-cloudimg-amd64.img"

# An image without its trusted checksum record must not be accepted as ready.
mv "$image_dir/noble-server-cloudimg-amd64.img.sha256" "$temporary_root/original-image.sha256"
if bash "$root/scripts/prepare-kvm-host.sh" --check >"$temporary_root/no-checksum.out" 2>&1; then
  echo "Host preflight unexpectedly accepted an image with no checksum record." >&2
  exit 1
fi
grep -Fq 'Trusted cloud-image checksum record missing or unsafe' "$temporary_root/no-checksum.out"
mv "$temporary_root/original-image.sha256" "$image_dir/noble-server-cloudimg-amd64.img.sha256"

# A host without an exposed KVM device must fail preflight, not report ready.
rm "$test_root/dev/kvm"
if bash "$root/scripts/prepare-kvm-host.sh" --check >"$temporary_root/no-kvm.out" 2>&1; then
  echo "Host preflight unexpectedly passed without /dev/kvm." >&2
  exit 1
fi
grep -Fq '/dev/kvm is missing' "$temporary_root/no-kvm.out"

# Invalid options must be rejected without any host mutation.
if bash "$root/scripts/prepare-kvm-host.sh" --unknown >"$temporary_root/invalid.out" 2>&1; then
  echo "Host preparation unexpectedly accepted an unknown option." >&2
  exit 1
fi
grep -Fq 'Unknown option' "$temporary_root/invalid.out"

echo "KVM host preparation/preflight tests passed."
