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

The host preparation helper supports **Ubuntu Server 24.04 LTS on x86-64 bare metal**. It installs KVM/libvirt/QEMU tools, activates libvirt's default NAT network, creates the host image/VM storage directories, and downloads Canonical's Ubuntu 24.04 AMD64 cloud image only after verifying the signed SHA-256 manifest.

Run on the **new Linux host** from this repository checkout:

```sh
sudo bash scripts/prepare-kvm-host.sh --install
sudo bash scripts/prepare-kvm-host.sh --check
```

The install mode requires root and may install packages and activate the libvirt default network. The check mode is read-only and fails if the host does not expose CPU virtualization and `/dev/kvm`, if libvirt cannot provide an x86-64 KVM guest, or if the cloud image/storage/network are not ready. It does not create any VM.

For the Compose host-agent, configure the host-side image and VM directories, the image map inside the container, and the numeric group ID of the libvirt socket. Starting values after running the helper are:

```sh
BHAI_IMAGE_DIR=/var/lib/bhai-garage/images
BHAI_VM_DIR=/var/lib/bhai-garage/vms
BHAI_IMAGES_JSON='{"ubuntu-24.04":"/var/lib/bhai-garage/images/noble-server-cloudimg-amd64.img"}'
BHAI_AGENT_UID=1000
BHAI_AGENT_GID=1000
LIBVIRT_GID=<numeric-group-id-of-/var/run/libvirt/libvirt-sock>
```

Do not switch `BHAI_PROVISIONER=libvirt` until the control plane has registered the host and it reports a fresh successful heartbeat.

**Networking boundary:** this helper only prepares libvirt's default NAT network for guest outbound connectivity. It intentionally does not alter host firewalls or public interfaces. The current host-agent domain XML does not yet allocate a public IP per VPS, assign provider-specific virtual MAC addresses, or create inbound port-forward rules; therefore public guest ingress remains an integration blocker even after host preflight passes. For example, OVHcloud documents a provider-specific Additional IP + virtual-MAC bridge workflow, whose availability depends on the exact server range: [virtual MAC for Additional IPs](https://docs.ovhcloud.com/en/guides/bare-metal-cloud/dedicated-servers/network-virtual-mac) and [bridged guest networking](https://docs.ovhcloud.com/en/guides/bare-metal-cloud/dedicated-servers/network-bridging). These steps require real IPs allocated to your account and must be validated against the purchased server. Keep management ports private, preserve SSH access, and only expose ports allowed by the host/provider firewall policy.

## Connect a Linux KVM/libvirt host

Real provisioning requires a Linux machine you control or rent, with hardware virtualization enabled (Intel VT-x or AMD-V), KVM, libvirt, QEMU, a working `qemu:///system` socket, and a configured libvirt network. The agent intentionally refuses remote libvirt URIs and only accepts a fixed set of image IDs.

1. Prepare the Linux host. Install a supported libvirt/QEMU stack, create and activate the `default` network (or configure another restricted network name), and verify the host can run a test VM using `virsh --connect qemu:///system`.
2. Prepare cloud-init-ready QCOW2 base images for supported IDs: `ubuntu-24.04`, `ubuntu-22.04`, `debian-12`, or `rocky-9`. Obtain images from their official publishers and check their checksums/signatures. Keep base images read-only to the agent.
3. In BHAI GARAGE, register a real host and copy its bearer token when shown. The plaintext token is only returned once. It is stored as a hash by the control plane.
4. Configure the host agent with the HTTPS control-plane URL ending in `/api`, the host token, and a JSON map from allowed image IDs to **absolute paths**. Example:

   ```sh
   BHAI_API_URL=https://garage.example.com/api
   BHAI_AGENT_TOKEN=<paste-the-one-time-host-token>
   BHAI_IMAGES_JSON='{"ubuntu-24.04":"/var/lib/bhai-garage/images/ubuntu-24.04.qcow2","debian-12":"/var/lib/bhai-garage/images/debian-12.qcow2"}'
   BHAI_VM_STORAGE=/var/lib/bhai-garage/vms
   BHAI_LIBVIRT_NETWORK=default
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

   For a local Docker Compose KVM host, save the one-time token in `.env`, set the image map to container paths under `/var/lib/bhai-garage/images`, set `LIBVIRT_GID` to the host socket's actual group ID, set `BHAI_HOSTNAME` to the physical host's name, and run `docker compose --profile libvirt up -d --build host-agent`. The agent uses host networking for accurate interface metrics and reaches the API through a loopback-only port. It mounts the libvirt socket, read-only images, and configured VM data directory; it does not mount the Docker socket or host root.
6. Wait for a fresh heartbeat, switch `BHAI_PROVISIONER=libvirt`, and restart the API. Create real VPS instances with a valid SSH public key. Requests are queued and only the host assigned to that token can claim them.

The agent sets vCPU and RAM in libvirt domain definitions and creates a QCOW2 overlay with the requested virtual capacity. Images must be cloud-init compatible. The configured virtual network must provide guest connectivity and DHCP leases for IP reporting. Confirm CPU architecture, image format, disk capacity, bridge/firewall policy, inbound SSH reachability, and guest initialization on your own host before offering the service to anyone.

**Real VM creation has not been tested here.** This development environment has no connected KVM/libvirt host, compatible base images, guest network, or public address allocation. Simulation is the only provider verified in this workspace.

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

PostgreSQL holds admin accounts/sessions, hosts, VPS metadata, queued operations, and audit events. Back up the database and the real host's VM storage separately. Deleting a real VPS removes its libvirt domain and its agent-owned files. There is no built-in customer billing, public VM networking/address allocation, backups, snapshots, rescue console, support desk, or uptime guarantee.

Running a hosting service also requires physical or rented hardware, electricity, cooling, a stable internet connection, sufficient upstream bandwidth, routable IP addresses or a tunnel, firewall/DDoS planning, storage backups, monitoring, security updates, and ongoing incident and hardware maintenance. Docker Compose does not supply those resources.
