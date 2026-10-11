# BHAI GARAGE

BHAI GARAGE is a self-owned VPS hosting **control-plane foundation**. It provides an admin dashboard, persistent inventory, authenticated lifecycle requests, audit history, and a scoped Linux host agent for KVM/libvirt.

The default `simulation` provider is deliberately labelled in the UI and API. It does not create virtual machines or provide compute. Real provisioning is only attempted when the control plane is set to `libvirt` and a compatible host agent, KVM host, libvirt network, and cloud images are actually connected.

## What is included

- Responsive admin dashboard for fleet health, host telemetry, VPS inventory, and audit events.
- One-time protected admin setup, scrypt password hashes, expiring HttpOnly session cookies, and login/setup rate limits.
- PostgreSQL persistence with Drizzle schemas and an explicit schema-push command.
- Validated REST endpoints documented in `lib/api-spec/openapi.yaml`; generated request schemas and browser hooks live in `lib/api-zod` and `lib/api-client-react`.
- Development simulator and an authenticated, allowlisted agent operation queue.
- Linux host agent that reports host capacity and executes only create/start/stop/restart/delete through `virsh`, `qemu-img`, and `cloud-localds`. It never provides a browser shell or host-root endpoint.
- Docker Compose for PostgreSQL, API, web frontend, and an optional `libvirt`-profile host agent.

## Run locally with Docker Compose

Requirements: Docker Engine with the Compose plugin, and OpenSSL for generating secrets.

```sh
cp .env.example .env
openssl rand -hex 32   # generate a unique value for POSTGRES_PASSWORD
openssl rand -hex 32   # generate a different value for SESSION_SECRET
openssl rand -hex 32   # generate a different value for BHAI_SETUP_TOKEN
```

Put the three generated values in the matching `.env` entries. Keep `.env` private and do not commit it.

```sh
docker compose up -d db
docker compose run --rm api pnpm --filter @workspace/db run push
docker compose up -d --build
```

Open `http://localhost:8080`. The first-admin setup screen requires the exact `BHAI_SETUP_TOKEN` from `.env`; setup can only succeed once. Use a password of at least 12 characters. The dashboard starts in simulation mode and clearly identifies simulated hosts, metrics, addresses, and lifecycle actions.

For an externally reachable deployment, put the web service behind a maintained TLS reverse proxy, restrict database and host-agent access to private networks, use strong unique secrets, and keep operating-system and container images updated. The included Nginx service is an internal HTTP frontend, not a public TLS terminator.

### Health endpoints

- `GET /api/healthz` — process liveness.
- `GET /api/readyz` — database connectivity/readiness.
- Nginx also exposes `/healthz` and `/readyz` aliases.

### Database backup and restore

Run these commands from the project directory on the machine that runs Docker Compose. The script backs up the Compose `db` PostgreSQL service to a local file; it does not back up VM disks or create live VM snapshots.

Create a backup:

```sh
bash scripts/backup-db.sh
```

By default, backups are written to `./backups/postgres`, protected by owner-only file permissions, accompanied by a SHA-256 checksum, and rotated after 14 days. You can change the destination and retention period with `BHAI_BACKUP_DIR` and `BHAI_BACKUP_RETENTION_DAYS`. Store a separate copy off the host; a backup on the same disk does not protect against disk loss.

Restore only when necessary. **This replaces matching database objects.** First take a fresh backup, stop the API so it cannot write during restoration, verify that the selected backup is the intended one, and then run:

```sh
docker compose stop api
bash scripts/restore-db.sh ./backups/postgres/your-backup.dump --confirm
docker compose start api
```

The restore script refuses to proceed without the explicit `--confirm` argument, a matching checksum file, and a valid SHA-256 digest. Verify the application and audit data after restore. Keep VM storage backups separate from PostgreSQL backups.

### Useful development commands

```sh
pnpm install
pnpm run typecheck
pnpm run build
pnpm --filter @workspace/db run push
pnpm --filter @workspace/api-server run test
pnpm --filter @workspace/host-agent run test
```

The API workflow uses port 5000 and the web artifact uses Vite. Set `BHAI_SETUP_TOKEN` before starting the API if you intend to create the first admin account. `SESSION_SECRET` and `DATABASE_URL` are also required for normal operation.

## Prepare a real KVM host

The host preparation helper supports **Ubuntu Server 24.04 LTS on x86-64 bare metal**. It installs KVM/libvirt/QEMU tools, activates libvirt's default NAT network, creates the host image/VM storage directories, and downloads Canonical's stable Ubuntu 24.04 AMD64 released cloud image (not a daily build) only after verifying the signed SHA-256 manifest.

Run on the **new Linux host** from this repository checkout:

```sh
sudo bash scripts/prepare-kvm-host.sh --install
sudo bash scripts/prepare-kvm-host.sh --check
```

The install mode requires root and may install packages and activate the libvirt default network. It stores base images and per-VPS disks below libvirt's standard `/var/lib/libvirt/images` tree so Ubuntu's default per-guest AppArmor policy can authorize the exact paths. The VM storage root and each VPS folder inherit the `libvirt-qemu` group and use setgid plus group-search-only access (`2710`), preventing directory listing while allowing QEMU to traverse the path. Each guest QCOW2 disk is group-readable/writable by QEMU (`0660`); its cloud-init ISO is group-readable (`0640`). Compose adds the numeric QEMU GID separately from the libvirt socket group, and the host-agent preflight validates group ownership, setgid mode and supplementary membership before registering the host. The live smoke test uses the same permissions. The Compose host-agent's `BHAI_IMAGE_DIRECTORY` is explicitly set to the mounted image path, and CI verifies both image root and VM storage match their mount destinations, including overridden `.env` paths. Re-run `--install` after upgrades to repair the QEMU group, setgid folder and managed guest-disk modes. These are metadata-only changes; guest disk contents are not rewritten. Custom paths outside the standard tree are rejected by this helper unless a separately reviewed AppArmor policy is configured. It verifies the Ubuntu cloud image against Canonical's signed SHA-256 manifest and stores a root-owned checksum record. The read-only check mode verifies that record and fails closed if the cached image has changed or its verification record is missing. For hosts prepared by an older version, run `--install` once to validate and record the cached image; if it is not the current signed release, investigate before replacing it, especially when VM disks depend on that base image. The check also fails if the host does not expose CPU virtualization and `/dev/kvm`, if libvirt cannot provide an x86-64 KVM guest, or if storage/network are not ready. It does not create any VM.

After preflight passes, run `sudo bash scripts/smoke-test-kvm-host.sh` on the actual KVM host. This opt-in live test creates a uniquely named temporary 1-vCPU/1-GiB Ubuntu guest on the default private NAT network, waits up to five minutes for a DHCP lease, and then undefines the test guest and removes its temporary files. It does not modify the public interface, firewall rules, or existing VM domains. If cleanup cannot be confirmed, it preserves the temporary files and reports the domain/path for manual recovery. The regular hosted CI checks this command's syntax/help only; it does not pretend to boot a VM without a real host.

### Offline VPS disk backups

For a conservative first backup path, power off the VPS cleanly and verify it is fully `shut off`. Mount a separate backup filesystem or off-host share at a dedicated mount point, then run the following on the KVM host (replace the domain with its actual `bg-` plus 32-hex ID):

```sh
sudo env BHAI_VM_BACKUP_DIR=/mnt/off-host-backups bash scripts/backup-vps-disks.sh bg-0123456789abcdef0123456789abcdef
```

The script refuses running, paused, or crashed guests; refuses a destination that is not a mount point or overlaps live VM storage; validates the source QCOW2; converts it to a standalone image (flattening its backing chain); captures the inactive libvirt domain XML; creates SHA-256 checksums; and publishes the bundle as one atomic directory rename. Verify a bundle with `sha256sum --check SHA256SUMS` from inside that backup directory. This is an **offline** backup and requires downtime; it does not back up the PostgreSQL control plane, provide an automatic restore, or replace scheduled off-host retention and restore drills. Keep the backup mount unavailable to customer guest VMs.

For the Compose host-agent, configure the host-side image and VM directories, the image map inside the container, and the numeric group ID of the libvirt socket. Starting values after running the helper are:

```sh
BHAI_IMAGE_DIR=/var/lib/libvirt/images/bhai-garage-base
BHAI_VM_DIR=/var/lib/libvirt/images/bhai-garage-vms
# Compose uses this exact absolute path inside and outside the container.
BHAI_IMAGE_DIRECTORY=/var/lib/libvirt/images/bhai-garage-base
BHAI_VM_STORAGE=/var/lib/libvirt/images/bhai-garage-vms
BHAI_IMAGES_JSON='{"ubuntu-24.04":"/var/lib/libvirt/images/bhai-garage-base/noble-server-cloudimg-amd64.img"}'
BHAI_AGENT_UID=1000
BHAI_AGENT_GID=1000
# Replace with output of: stat -c %g /var/run/libvirt/libvirt-sock
LIBVIRT_GID=replace_with_numeric_socket_group_id
# Replace with output of: getent group libvirt-qemu | cut -d: -f3
BHAI_QEMU_GID=replace_with_numeric_qemu_group_id
```

The optional public guest network is configured per VPS at creation time in the dashboard. Only enter a provider-assigned public IPv4 address, prefix length, gateway, nameservers, and provider-issued virtual MAC. To use it, configure and verify a provider-compatible Linux bridge on the KVM host, then set `BHAI_LIBVIRT_BRIDGE` to that existing bridge in the host-agent environment. The agent preflight checks the bridge exists, is a Linux bridge, and is UP before accepting host work. It does not create the bridge or modify Netplan/firewall rules. Leave all public-network fields empty to use the default NAT/DHCP network.

This feature adds `vps_instances.public_network` and unique public IPv4/virtual-MAC indexes. Before deploying the updated API to an existing database, take a backup, run the documented database schema push, and verify readiness before enabling public networking. Do not guess or reuse an IP or virtual MAC, and do not set public-network details unless the provider has routed/assigned them to this physical server.

Do not switch `BHAI_PROVISIONER=libvirt` until the control plane has registered the host and it reports a fresh successful heartbeat.

**Networking boundary:** the helper prepares only libvirt's default NAT network and deliberately does not change host firewall rules or the physical public interface. The control plane now accepts an optional static public network tuple per real VPS (provider-assigned IPv4, prefix, gateway, DNS IPv4s, and the provider-issued virtual MAC). When these fields are supplied, the host agent uses cloud-init static networking and attaches that VM to an already configured Linux bridge named by `BHAI_LIBVIRT_BRIDGE`. Leave all fields blank for NAT/DHCP. Never invent an IP or virtual MAC. The provider must actually route the address to the server, and the assigned virtual MAC must match the provider portal. For example, OVHcloud documents product-dependent Additional IP virtual MAC assignment and bridged guest networking: [virtual MAC for Additional IPs](https://docs.ovhcloud.com/en/guides/bare-metal-cloud/dedicated-servers/network-virtual-mac) and [bridged guest networking](https://docs.ovhcloud.com/en/guides/bare-metal-cloud/dedicated-servers/network-bridging). Prepare the bridge using the provider's current instructions before enabling `BHAI_LIBVIRT_BRIDGE`; this automated helper intentionally does not edit Netplan, firewall rules, or public host networking because mistakes can lock out SSH. Public ingress and guest egress must still be smoke-tested on the purchased server.

## Connect a Linux KVM/libvirt host

Real provisioning requires a Linux machine you control or rent, with hardware virtualization enabled (Intel VT-x or AMD-V), KVM, libvirt, QEMU, a working `qemu:///system` socket, and a configured libvirt network. The agent intentionally refuses remote libvirt URIs and only accepts a fixed set of image IDs.

1. Prepare the Linux host. Install a supported libvirt/QEMU stack, create and activate the `default` network (or configure another restricted network name), and verify the host can run a test VM using `virsh --connect qemu:///system`.
2. Prepare cloud-init-ready QCOW2 base images for supported IDs: `ubuntu-24.04`, `ubuntu-22.04`, `debian-12`, or `rocky-9`. Obtain images from their official publishers and check their checksums/signatures. Keep base images read-only to the agent.
3. In BHAI GARAGE, register a real host and copy its bearer token when shown. The plaintext token is only returned once. It is stored as a hash by the control plane.
4. Configure the host agent with the HTTPS control-plane URL ending in `/api`, the host token, and a JSON map from allowed image IDs to **absolute paths**. Example:

   ```sh
   BHAI_API_URL=https://garage.example.com/api
   BHAI_AGENT_TOKEN=<paste-the-one-time-host-token>
   BHAI_IMAGES_JSON='{"ubuntu-24.04":"/var/lib/libvirt/images/bhai-garage-base/ubuntu-24.04.qcow2","debian-12":"/var/lib/libvirt/images/bhai-garage-base/debian-12.qcow2"}'
   BHAI_VM_STORAGE=/var/lib/libvirt/images/bhai-garage-vms
   BHAI_LIBVIRT_NETWORK=default
# Optional; uncomment only after a provider-compatible Linux bridge exists and is UP.
# BHAI_LIBVIRT_BRIDGE=br-ex
   ```

   Protect the agent environment file with owner-only permissions. Add the service user to the host's libvirt socket group, and grant it write access only to the VM storage directory.
5. Run the agent on the host from this repository with Node.js 24:

   ```sh
   node --experimental-strip-types packages/host-agent/src/index.ts
   ```

   **Startup preflight runs before the first heartbeat.** The host will not appear online until all checks pass:
   - The configured local libvirt connection answers through `qemu:///system`.
   - The host exposes `x86_64` KVM acceleration and the selected libvirt network is active.
   - The VM storage directory is writable by the agent service account.
   - At least one configured image is a readable QCOW2 file located inside `BHAI_IMAGE_DIRECTORY`, and `cloud-localds` is installed.

   To diagnose a host that never becomes online, inspect its service/container logs for `preflight-started`, `preflight-passed`, or `startup-failed`. Fix the specific missing dependency or permission, then restart the agent. Do not switch `BHAI_PROVISIONER=libvirt` until the host reports a fresh successful heartbeat.

   **Operation recovery and uncertain state:** an operation that reaches the retry limit without a completion response is marked `failed`, and an `agent.operation.exhausted` audit event records its action, attempt count, and last recorded state. This deliberately avoids guessing whether a VM action completed before the response was lost. Before retrying or deleting that VPS, inspect its domain with `virsh --connect qemu:///system list --all` and reconcile the actual VM and disk state manually.

   For a local Docker Compose KVM host, save the one-time token in `.env`, set the image map to container paths under `/var/lib/libvirt/images/bhai-garage-base`, set `LIBVIRT_GID` to the host socket's actual group ID, set `BHAI_HOSTNAME` to the physical host's name, and run `docker compose --profile libvirt up -d --build host-agent`. The agent uses host networking for accurate interface metrics and reaches the API through a loopback-only port. It mounts the libvirt socket, read-only images, and configured VM data directory; it does not mount the Docker socket or host root.
6. Wait for a fresh heartbeat, switch `BHAI_PROVISIONER=libvirt`, and restart the API. Create real VPS instances with a valid SSH public key. Requests are queued and only the host assigned to that token can claim them.

The agent sets vCPU and RAM in libvirt domain definitions and creates a QCOW2 overlay with the requested virtual capacity. Images must be cloud-init compatible. The configured virtual network must provide guest connectivity and DHCP leases for IP reporting. Confirm CPU architecture, image format, disk capacity, bridge/firewall policy, inbound SSH reachability, and guest initialization on your own host before offering the service to anyone.

**Live-host requirement:** CI validates the smoke-test script and host-agent unit tests but does not boot a real guest. After `--install` and `--check` pass on the actual host, run `sudo bash scripts/smoke-test-kvm-host.sh`. Require a real guest boot plus private NAT DHCP lease before switching the control plane to real provisioning. No compatible KVM host is connected to this development environment, so that hardware-level proof remains outstanding.

## API overview

All routes are under `/api`. Admin routes use the HttpOnly admin session cookie; host-agent routes require that host's bearer token.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/healthz`, `/readyz` | Liveness and readiness |
| GET | `/auth/setup-status` | Initial setup status |
| POST | `/auth/setup` | One-time admin bootstrap |
| POST | `/auth/login`, `/auth/logout` | Admin session lifecycle |
| GET | `/auth/session` | Current admin session |
| GET | `/dashboard` | Fleet totals and resource telemetry |
| GET/POST | `/vps` | Search/filter inventory and create a VPS |
| GET | `/vps/{id}` | VPS details |
| POST | `/vps/{id}/actions` | Start, stop, or restart |
| POST | `/vps/{id}/delete` | Delete simulation record or queue real deletion |
| GET/POST | `/hosts` | List hosts or register a real agent |
| GET | `/audit` | Recent audit events |
| POST | `/agent/heartbeat` | Authenticated host metrics |
| POST | `/agent/operations/next` | Claim one operation for this host |
| POST | `/agent/operations/{operationId}/complete` | Report its result |

The complete schemas and status codes are in `lib/api-spec/openapi.yaml`. Never put the host bearer token in a browser client.

## Data and ownership

PostgreSQL holds admin accounts/sessions, hosts, VPS metadata, queued operations, and audit events. The API supports an optional provider-assigned public-network tuple per VPS, but it does not allocate public IPs; the provider bridge/routing still needs host-specific configuration. Back up the database and the real host's VM storage separately. The offline disk-backup script is a manual, shut-off-guest backup utility, not a scheduler or restore service. Deleting a real VPS removes its libvirt domain and its agent-owned files. There is no customer account/tenant billing system, live snapshots, rescue console, support desk, or uptime guarantee.

Running a hosting service also requires physical or rented hardware, electricity, cooling, a stable internet connection, sufficient upstream bandwidth, routable IP addresses or a tunnel, firewall/DDoS planning, storage backups, monitoring, security updates, and ongoing incident and hardware maintenance. Docker Compose does not supply those resources.
