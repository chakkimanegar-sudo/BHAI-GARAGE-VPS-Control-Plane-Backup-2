# BHAI GARAGE

A portable VPS hosting control-plane foundation with a simulation-first dashboard and an optional authenticated KVM/libvirt host agent.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — typecheck all libraries, artifacts, and packages
- `pnpm run build` — typecheck and build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI
- `pnpm --filter @workspace/db run push` — apply DB schema changes (development)
- `pnpm --filter @workspace/api-server run test` — API/auth/persistence/lifecycle integration tests
- `pnpm --filter @workspace/host-agent run test` — host-agent safety/configuration tests
- Required env: `DATABASE_URL`, `SESSION_SECRET`, and `BHAI_SETUP_TOKEN` for initial admin bootstrap

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod
- API codegen: Orval from the OpenAPI spec
- Host agent: Node.js 24, local libvirt socket, `virsh`, `qemu-img`, `cloud-localds`

## Where things live

- `artifacts/bhai-garage` — React/Vite admin dashboard
- `artifacts/api-server` — REST API and host-agent protocol
- `lib/api-spec/openapi.yaml` — API contract; generated clients/schemas are in `lib/api-client-react` and `lib/api-zod`
- `lib/db/src/schema` — PostgreSQL/Drizzle schema
- `packages/host-agent` — Linux host agent and KVM/libvirt adapter
- `docker-compose.yml`, Dockerfiles, and `README.md` — portable deployment guidance

## Architecture decisions

- Simulation is the safe default and its hosts, VPS records, addresses, and metrics are labeled as simulated.
- Real lifecycle requests are queued per host and authenticated with a hashed host-specific bearer token.
- The agent executes only allowlisted VM lifecycle actions; it has no browser shell, Docker socket, or host-root API.
- First-admin setup is disabled unless `BHAI_SETUP_TOKEN` is configured; sessions require `SESSION_SECRET`.
- The real provider supports only local `qemu:///system`, allowlisted cloud image IDs, and SSH-key injection.

## Product

The admin can inspect host resource health, search and filter VPS inventory, create and manage simulated instances, register real hosts, view agent status, and review audit events. Real VM creation needs compatible external hardware and networking.

## User preferences

Keep the project exportable and self-hostable; do not describe simulation or a dashboard as free/live compute.

## Gotchas

- Apply the DB schema before starting the API against a fresh database.
- Real provisioning needs an online host, a supported cloud-init QCOW2 image on that host, and a valid SSH public key.
- Docker Compose's libvirt profile requires a compatible Linux KVM host and the actual libvirt socket group ID. It cannot be verified inside this workspace.

## Pointers

- See the `pnpm-workspace` skill for workspace structure and TypeScript setup.
- See `README.md` for Compose deployment, host-agent setup, security, and physical hosting requirements.
