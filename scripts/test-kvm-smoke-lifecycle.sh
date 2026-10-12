#!/usr/bin/env bash
set -Eeuo pipefail

[[ "$EUID" -eq 0 ]] || { echo "Run this isolated smoke-test harness as root." >&2; exit 1; }
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d)"
libvirt_root="/var/lib/libvirt/images"
mkdir -p "$libvirt_root"
image_dir="$(mktemp -d "$libvirt_root/.bhai-smoke-image.XXXXXXXX")"
vm_dir="$(mktemp -d "$libvirt_root/.bhai-smoke-vms.XXXXXXXX")"
cleanup_test() { rm -rf -- "$test_root" "$image_dir" "$vm_dir"; }
trap cleanup_test EXIT

project="$test_root/project"
fake_bin="$test_root/bin"
state_dir="$test_root/fake-state"
mkdir -p "$project/scripts" "$fake_bin" "$state_dir"
cp "$root/scripts/smoke-test-kvm-host.sh" "$project/scripts/smoke-test-kvm-host.sh"
cat > "$project/scripts/prepare-kvm-host.sh" <<'PREFLIGHT'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${1:-}" == "--check" ]] || exit 2
echo "PASS: mocked host preflight"
PREFLIGHT
chmod 0700 "$project/scripts/prepare-kvm-host.sh"
printf 'FAKE-VERIFIED-UBUNTU-CLOUD-IMAGE\n' > "$image_dir/noble-server-cloudimg-amd64.img"

cat > "$fake_bin/virsh" <<'FAKE_VIRSH'
#!/usr/bin/env bash
set -Eeuo pipefail
command="${3:-}"
printf '%s\n' "$*" >> "$FAKE_STATE_DIR/virsh.log"
domain_file="$FAKE_STATE_DIR/domain"
state_file="$FAKE_STATE_DIR/state"
case "$command" in
  list)
    if [[ -f "$domain_file" ]]; then cat "$domain_file"; fi
    ;;
  define)
    xml="$4"
    name="$(sed -n 's:.*<name>\([^<]*\)</name>.*:\1:p' "$xml" | head -n 1)"
    [[ "$name" =~ ^bhai-garage-smoke-[0-9a-f]{12}$ ]] || exit 91
    [[ ! -f "$domain_file" ]] || exit 92
    printf '%s\n' "$name" > "$domain_file"
    printf 'shut off\n' > "$state_file"
    ;;
  start)
    [[ -f "$domain_file" && "$(cat "$domain_file")" == "$4" ]] || exit 93
    printf 'running\n' > "$state_file"
    ;;
  shutdown|destroy)
    [[ -f "$domain_file" && "$(cat "$domain_file")" == "$4" ]] || exit 94
    printf 'shut off\n' > "$state_file"
    ;;
  domstate)
    [[ -f "$domain_file" && "$(cat "$domain_file")" == "$4" ]] || exit 95
    cat "$state_file"
    ;;
  domifaddr)
    [[ -f "$domain_file" && "$(cat "$domain_file")" == "$4" ]] || exit 96
    [[ "$(cat "$state_file")" == "running" ]] || exit 97
    printf ' Name  MAC address  Protocol  Address\n'
    printf ' vnet0  52:54:00:00:00:01  ipv4  192.168.122.42/24\n'
    ;;
  undefine)
    [[ -f "$domain_file" && "$(cat "$domain_file")" == "$4" ]] || exit 98
    rm -f -- "$domain_file" "$state_file"
    ;;
  *)
    echo "Unexpected fake virsh command: $*" >&2
    exit 99
    ;;
esac
FAKE_VIRSH

cat > "$fake_bin/qemu-img" <<'FAKE_QEMU'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${1:-}" == "create" ]] || { echo "Unexpected fake qemu-img command: $*" >&2; exit 81; }
disk="${@: -2:1}"
printf 'FAKE-QCOW2-OVERLAY\n' > "$disk"
FAKE_QEMU

cat > "$fake_bin/cloud-localds" <<'FAKE_CLOUD_LOCALDS'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'FAKE-SEED-ISO\n' > "$1"
FAKE_CLOUD_LOCALDS

cat > "$fake_bin/ssh" <<'FAKE_SSH'
#!/usr/bin/env bash
set -Eeuo pipefail
remote_command="${@: -1}"
printf '%s\n' "$remote_command" >> "$FAKE_STATE_DIR/ssh.log"
if [[ "$remote_command" == "true" ]]; then
  exit 0
fi
if [[ "$remote_command" == "sudo -n cloud-init status --wait --long" ]]; then
  printf 'status: done\n'
  exit 0
fi
echo "Unexpected fake SSH command: $remote_command" >&2
exit 82
FAKE_SSH

chmod 0700 "$fake_bin/virsh" "$fake_bin/qemu-img" "$fake_bin/cloud-localds" "$fake_bin/ssh"
export FAKE_STATE_DIR="$state_dir"

if ! output="$(PATH="$fake_bin:$PATH" \
  BHAI_IMAGE_DIR="$image_dir" BHAI_VM_DIR="$vm_dir" \
  BHAI_AGENT_UID=0 BHAI_AGENT_GID=0 BHAI_QEMU_GID=0 \
  bash "$project/scripts/smoke-test-kvm-host.sh" 2>&1)"; then
  printf '%s\n' "$output" >&2
  echo "FAIL: simulated KVM lifecycle harness did not complete." >&2
  exit 1
fi

for expected in \
  "guest SSH is reachable at private NAT IP 192.168.122.42" \
  "initial boot: cloud-init status is done" \
  "Guest stop lifecycle succeeded." \
  "start after stop: cloud-init status is done" \
  "Guest start lifecycle succeeded after a clean shutdown." \
  "Guest delete lifecycle succeeded" \
  "Temporary VM storage and ephemeral SSH key deleted."; do
  grep -Fq "$expected" <<<"$output" || {
    printf '%s\n' "$output" >&2
    echo "FAIL: expected lifecycle evidence missing: $expected" >&2
    exit 1
  }
done

[[ "$(grep -c ' start ' "$state_dir/virsh.log")" -eq 2 ]]
[[ "$(grep -c ' shutdown ' "$state_dir/virsh.log")" -eq 2 ]]
[[ "$(grep -c ' undefine ' "$state_dir/virsh.log")" -eq 1 ]]
[[ "$(grep -c '^sudo -n cloud-init status --wait --long$' "$state_dir/ssh.log")" -eq 2 ]]
[[ ! -e "$state_dir/domain" ]]
if find "$vm_dir" -mindepth 1 -maxdepth 1 -name '.kvm-smoke.*' -print -quit | grep -q .; then
  echo "FAIL: simulated KVM temporary storage leaked after successful cleanup." >&2
  exit 1
fi

printf '%s\n' "$output"
echo "PASS: simulated KVM smoke-test lifecycle regression checks passed."
