#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")/.." && pwd)"
temporary_root="$(mktemp -d)"
trap 'rm -rf -- "$temporary_root"' EXIT

test_root="$temporary_root/host"
fake_bin="$temporary_root/bin"
image_dir="$test_root/var/lib/bhai-garage/images"
vm_dir="$test_root/var/lib/bhai-garage/vms"
mkdir -p "$fake_bin" "$image_dir" "$vm_dir" "$test_root/etc" "$test_root/proc" "$test_root/dev"

cat > "$test_root/etc/os-release" <<'OS_RELEASE'
ID=ubuntu
VERSION_ID="24.04"
PRETTY_NAME="Ubuntu 24.04 LTS (test fixture)"
OS_RELEASE
printf 'processor flags : fpu vmx sse sse2\n' > "$test_root/proc/cpuinfo"
: > "$test_root/dev/kvm"
printf 'mock qcow2 image\n' > "$image_dir/noble-server-cloudimg-amd64.img"

cat > "$fake_bin/virsh" <<'FAKE_VIRSH'
#!/usr/bin/env bash
set -Eeuo pipefail
case "\${3:-}" in
  uri) printf 'qemu:///system\n' ;;
  capabilities)
    printf "%s\n" "<capabilities><host><cpu><arch>x86_64</arch></cpu></host><guest><arch name='x86_64'><domain type='kvm'></domain></arch></guest></capabilities>"
    ;;
  net-info) printf 'Name: default\nActive: yes\n' ;;
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
export BHAI_IMAGE_DIR=/var/lib/bhai-garage/images
export BHAI_VM_DIR=/var/lib/bhai-garage/vms
export BHAI_AGENT_UID="$(id -u)"
export BHAI_AGENT_GID="$(id -g)"

check_output="$(bash "$root/scripts/prepare-kvm-host.sh" --check)"
grep -Fq 'PASS: Ubuntu 24.04 x86_64 host exposes CPU virtualization and /dev/kvm.' <<<"$check_output"
grep -Fq 'PASS: libvirt KVM guest support and active default network verified.' <<<"$check_output"
grep -Fq 'PASS: KVM host preflight passed.' <<<"$check_output"
grep -Fq 'does not assign public IPs to guests' <<<"$check_output"

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
