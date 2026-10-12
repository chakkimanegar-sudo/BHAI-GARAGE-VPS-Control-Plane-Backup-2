#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Restore a verified offline BHAI GARAGE VPS disk backup as an inactive libvirt domain.

Usage:
  sudo env BHAI_VM_STORAGE=/var/lib/libvirt/images/bhai-garage-vms \
    BHAI_AGENT_UID=1000 BHAI_QEMU_GID=640 \
    bash scripts/restore-vps-disk-backup.sh /mnt/off-host-backups/<bundle> --confirm

The restore verifies SHA-256s and QCOW2 integrity, refuses existing domains or
storage, rebuilds a conservative x86-64 definition on libvirt's default NAT
network, and never starts the restored guest or restores a public bridge/IP.
PostgreSQL/control-plane metadata is separate and is not restored here.
USAGE
}
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then usage; exit 0; fi
[[ "$#" -eq 2 && "$2" == "--confirm" ]] || { usage >&2; fail "Supply a bundle path and explicit --confirm."; }
[[ "$EUID" -eq 0 ]] || fail "Run restore as root."

bundle="$1"
vm_storage="${BHAI_VM_STORAGE:-/var/lib/libvirt/images/bhai-garage-vms}"
agent_uid="${BHAI_AGENT_UID:-1000}"
qemu_gid="${BHAI_QEMU_GID:-}"

for tool in virsh qemu-img python3 sha256sum realpath install cp chown chmod; do
  command -v "$tool" >/dev/null 2>&1 || fail "Required command is missing: $tool"
done
[[ "$agent_uid" =~ ^[0-9]+$ ]] || fail "BHAI_AGENT_UID must be numeric."
[[ "$qemu_gid" =~ ^[0-9]+$ ]] || fail "Set BHAI_QEMU_GID to the numeric libvirt-qemu group ID."
[[ -d "$bundle" && ! -L "$bundle" ]] || fail "Backup bundle must be a real directory: $bundle"
[[ -d "$vm_storage" && ! -L "$vm_storage" ]] || fail "VM storage must be a real directory: $vm_storage"

bundle_real="$(realpath -e -- "$bundle")"
storage_real="$(realpath -e -- "$vm_storage")"
[[ "$bundle_real" != "$storage_real" && "$bundle_real" != "$storage_real/"* && "$storage_real" != "$bundle_real/"* ]] ||
  fail "Backup bundle and VM storage must be separate, non-nested paths."
libvirt_root_real="$(realpath -e -- /var/lib/libvirt/images)" ||
  fail "Standard libvirt image root is missing."
[[ "$storage_real" == "$libvirt_root_real/"* ]] ||
  fail "VM storage must stay under /var/lib/libvirt/images for the default AppArmor policy."

for file in root.qcow2 domain.xml disk-info.json manifest.txt SHA256SUMS; do
  [[ -f "$bundle_real/$file" && ! -L "$bundle_real/$file" ]] || fail "Missing/unsafe bundle file: $file"
done
if [[ -e "$bundle_real/cloud-init.iso" ]]; then
  [[ -f "$bundle_real/cloud-init.iso" && ! -L "$bundle_real/cloud-init.iso" ]] || fail "Unsafe cloud-init ISO."
fi

python3 - "$bundle_real/SHA256SUMS" "$bundle_real/cloud-init.iso" <<'PY' ||
import pathlib,re,sys
checks=pathlib.Path(sys.argv[1])
seed=pathlib.Path(sys.argv[2]).is_file()
lines=checks.read_text(encoding="utf-8").splitlines()
names=[]
for line in lines:
    m=re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)",line)
    if not m: raise SystemExit("Unsafe SHA256SUMS entry")
    names.append(m.group(2))
required={"root.qcow2","domain.xml","disk-info.json","manifest.txt"}
expected=required|({"cloud-init.iso"} if seed else set())
if len(names)!=len(set(names)) or set(names)!=expected:
    raise SystemExit("Checksum entries do not exactly match allowed bundle files")
PY
  fail "Checksum manifest has unsafe, missing, duplicate or unexpected entries."
(cd "$bundle_real" && sha256sum --check --strict SHA256SUMS) || fail "Backup checksum verification failed."
grep -Fxq 'format=BHAI-GARAGE-VPS-DISK-BACKUP-V1' "$bundle_real/manifest.txt" || fail "Unsupported backup format."
[[ "$(grep -c '^domain=' "$bundle_real/manifest.txt")" -eq 1 ]] || fail "Backup manifest must contain one domain."
domain="$(sed -n 's/^domain=//p' "$bundle_real/manifest.txt")"
[[ "$domain" =~ ^bg-[0-9a-f]{32}$ ]] || fail "Invalid domain name in backup manifest."
grep -Fxq 'disk_format=qcow2' "$bundle_real/manifest.txt" || fail "Backup manifest does not identify QCOW2."

if virsh --connect qemu:///system list --all --name | grep -Fxq "$domain"; then
  fail "Domain $domain already exists; refusing to overwrite it."
fi
target_dir="$storage_real/$domain"
[[ ! -e "$target_dir" && ! -L "$target_dir" ]] || fail "Storage already exists; refusing to overwrite: $target_dir"
network_info="$(virsh --connect qemu:///system net-info default)" || fail "Libvirt default network is not defined."
grep -Eq '^[[:space:]]*Active:[[:space:]]+yes' <<<"$network_info" || fail "Libvirt default NAT network is not active."

disk_info="$(qemu-img info --output=json "$bundle_real/root.qcow2")" || fail "qemu-img cannot read the backup."
python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("format")=="qcow2" and not d.get("backing-filename") and not d.get("full-backing-filename") else 1)' <<<"$disk_info" ||
  fail "Backup must be a standalone QCOW2 image with no backing file."
qemu-img check -f qcow2 "$bundle_real/root.qcow2" >/dev/null || fail "QCOW2 consistency check failed."

details="$(python3 - "$bundle_real/domain.xml" "$domain" <<'PY'
import sys,xml.etree.ElementTree as ET
path,want=sys.argv[1:]
try: root=ET.parse(path).getroot()
except Exception as e: raise SystemExit("Invalid archived domain XML: "+str(e))
if [(n.text or "") for n in root.findall("./name")] != [want]:
    raise SystemExit("Domain XML name differs from backup manifest")
disks=root.findall("./devices/disk[@device='disk']")
if len(disks)!=1: raise SystemExit("Only one-root-disk backups can be restored")
src=disks[0].find("source")
if disks[0].get("type")!="file" or src is None or not src.get("file") or not src.get("file","").endswith("/root.qcow2"):
    raise SystemExit("Unexpected root disk source")
m=root.find("memory"); v=root.find("vcpu")
if m is None or not (m.text or "").strip() or v is None or not (v.text or "").strip():
    raise SystemExit("Archived memory/vCPU values are missing")
try: mv=int(m.text.strip()); vv=int(v.text.strip())
except ValueError: raise SystemExit("Memory/vCPU values are not numeric")
unit=(m.get("unit") or "KiB").lower()
scale={"b":1/(1024*1024),"kib":1/1024,"mib":1,"gib":1024}
if unit not in scale: raise SystemExit("Unsupported memory unit")
mib=int(mv*scale[unit]+0.999999)
if not 512<=mib<=262144: raise SystemExit("Memory must be 512-262144 MiB")
if not 1<=vv<=32: raise SystemExit("vCPU count must be 1-32")
print(want+"\t"+str(mib)+"\t"+str(vv))
PY
)" || fail "Archived domain XML failed safety checks."
IFS=$'\t' read -r checked_domain memory_mib vcpus <<<"$details"
[[ "$checked_domain" == "$domain" && "$memory_mib" =~ ^[0-9]+$ && "$vcpus" =~ ^[0-9]+$ ]] || fail "Could not read safe VM resources."

created=0
define_attempted=0
completed=0
cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$status" -ne 0 && "$created" -eq 1 && -d "$target_dir" ]]; then
    if [[ "$define_attempted" -eq 1 ]] && virsh --connect qemu:///system list --all --name 2>/dev/null | grep -Fxq "$domain"; then
      printf 'ERROR: Domain may exist after a failed define; preserving guest files at %s for manual inspection.\n' "$target_dir" >&2
    else
      rm -rf -- "$target_dir"
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
umask 077
install -d -o "$agent_uid" -g "$qemu_gid" -m 2710 "$target_dir"
created=1
cp --reflink=auto -- "$bundle_real/root.qcow2" "$target_dir/root.qcow2"
chown "$agent_uid:$qemu_gid" "$target_dir/root.qcow2"
chmod 0660 "$target_dir/root.qcow2"
if [[ -f "$bundle_real/cloud-init.iso" ]]; then
  cp --reflink=auto -- "$bundle_real/cloud-init.iso" "$target_dir/cloud-init.iso"
  chown "$agent_uid:$qemu_gid" "$target_dir/cloud-init.iso"
  chmod 0640 "$target_dir/cloud-init.iso"
fi
for file in manifest.txt disk-info.json domain.xml; do
  cp -- "$bundle_real/$file" "$target_dir/backup-$file"
  chown "$agent_uid:$qemu_gid" "$target_dir/backup-$file"
  chmod 0640 "$target_dir/backup-$file"
done

python3 - "$target_dir/domain.xml" "$domain" "$memory_mib" "$vcpus" "$target_dir/root.qcow2" "$target_dir/cloud-init.iso" <<'PY'
import os,sys,xml.etree.ElementTree as ET
path,name,mem,cpu,disk,seed=sys.argv[1:]
root=ET.Element("domain",{"type":"kvm"})
ET.SubElement(root,"name").text=name
ET.SubElement(root,"memory",{"unit":"MiB"}).text=mem
ET.SubElement(root,"currentMemory",{"unit":"MiB"}).text=mem
ET.SubElement(root,"vcpu",{"placement":"static"}).text=cpu
osn=ET.SubElement(root,"os")
ET.SubElement(osn,"type",{"arch":"x86_64","machine":"q35"}).text="hvm"
ET.SubElement(osn,"boot",{"dev":"hd"})
features=ET.SubElement(root,"features")
ET.SubElement(features,"acpi"); ET.SubElement(features,"apic")
ET.SubElement(root,"cpu",{"mode":"host-passthrough","check":"none"})
ET.SubElement(root,"clock",{"offset":"utc"})
ET.SubElement(root,"on_poweroff").text="destroy"
ET.SubElement(root,"on_reboot").text="restart"
ET.SubElement(root,"on_crash").text="destroy"
devices=ET.SubElement(root,"devices")
d=ET.SubElement(devices,"disk",{"type":"file","device":"disk"})
ET.SubElement(d,"driver",{"name":"qemu","type":"qcow2","cache":"none","discard":"unmap"})
ET.SubElement(d,"source",{"file":disk})
ET.SubElement(d,"target",{"dev":"vda","bus":"virtio"})
if os.path.isfile(seed):
    cd=ET.SubElement(devices,"disk",{"type":"file","device":"cdrom"})
    ET.SubElement(cd,"driver",{"name":"qemu","type":"raw"})
    ET.SubElement(cd,"source",{"file":seed})
    ET.SubElement(cd,"target",{"dev":"sda","bus":"sata"})
    ET.SubElement(cd,"readonly")
net=ET.SubElement(devices,"interface",{"type":"network"})
ET.SubElement(net,"source",{"network":"default"})
ET.SubElement(net,"model",{"type":"virtio"})
console=ET.SubElement(devices,"console",{"type":"pty"})
ET.SubElement(console,"target",{"type":"serial","port":"0"})
ET.indent(root,space="  ")
ET.ElementTree(root).write(path,encoding="unicode")
with open(path,"a",encoding="utf-8") as out: out.write("\n")
PY
chown "$agent_uid:$qemu_gid" "$target_dir/domain.xml"
chmod 0640 "$target_dir/domain.xml"
chown "$agent_uid:$qemu_gid" "$target_dir"
chmod 2710 "$target_dir"
if virsh --connect qemu:///system list --all --name | grep -Fxq "$domain"; then fail "Domain appeared during restore; refusing to define."; fi
define_attempted=1
virsh --connect qemu:///system define "$target_dir/domain.xml"
completed=1
printf 'VPS disk restored and domain defined (not started): %s\n' "$domain"
printf 'Disk: %s/root.qcow2\n' "$target_dir"
printf 'Network: default libvirt NAT (no public IP or bridge restored).\n'
printf 'Reconcile PostgreSQL metadata and verify networking before starting the domain.\n'
