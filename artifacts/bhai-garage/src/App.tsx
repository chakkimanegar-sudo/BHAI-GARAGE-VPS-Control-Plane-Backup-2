import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  Activity, AlertCircle, ArrowDownLeft, ArrowLeft, ArrowUpRight, Check, ChevronRight,
  Clipboard, HardDrive, LogOut, MonitorCog, Plus, Power, RefreshCw, Search, Server,
  ShieldCheck, Signal, Terminal, X,
} from 'lucide-react';
import {
  getGetAdminSessionQueryKey, getGetDashboardQueryKey, getGetSetupStatusQueryKey,
  getGetVpsQueryKey, getListAuditEventsQueryKey, getListHostsQueryKey, getListVpsQueryKey,
  useCreateVps, useDeleteVps, useGetAdminSession, useGetDashboard, useGetSetupStatus,
  useGetVps, useHealthCheck, useListAuditEvents, useListHosts, useListVps,
  useLoginAdmin, useLogoutAdmin, useOperateVps, useReadinessCheck, useRegisterHost, useSetupAdmin,
} from '@workspace/api-client-react';
import type { AuditEvent, Host, VpsInstance, VpsStatusFilter } from '@workspace/api-client-react';
import { Link, Route, Switch, useLocation, useParams, Router as WouterRouter } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import './index.css';

const queryClient = new QueryClient();

function fmtDate(value?: string | null) {
  if (!value) return 'Never reported';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function ago(value?: string | null) {
  if (!value) return 'Never';
  const mins = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}
function gb(mb: number) { return `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB`; }
function errorMessage(error: unknown) {
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  return 'The request could not be completed. Check the connection and retry.';
}
function Status({ value }: { value: string }) {
  const label = value === 'online' ? 'Online' : value.charAt(0).toUpperCase() + value.slice(1);
  return <span className={`status ${value}`}>{label}</span>;
}
function Provenance({ simulation }: { simulation: boolean }) {
  return simulation ? <span className="provenance">Simulation</span> : <span className="source-line"><i className="source-led" />Reported host state</span>;
}
function LoadingCards() {
  return <div className="stat-grid">{[0,1,2,3].map(i => <div className="panel skeleton skeleton-card" key={i} />)}</div>;
}
function LoadError({ error, retry }: { error: unknown; retry: () => void }) {
  return <div className="error-box"><span><AlertCircle size={16} style={{ verticalAlign: 'middle', marginRight: 8 }} />{errorMessage(error)}</span><button className="button button-secondary button-small" onClick={retry} data-testid="button-retry">Retry</button></div>;
}

function AuthGate() {
  const setup = useGetSetupStatus();
  const session = useGetAdminSession({ query: { queryKey: getGetAdminSessionQueryKey(), retry: false } });
  const [loc, setLoc] = useLocation();
  if (setup.isLoading || session.isLoading) return <div className="auth-wrap"><div className="auth-panel"><div className="auth-card"><div className="skeleton" style={{ height: 28, width: 190, marginBottom: 24 }} /><div className="skeleton" style={{ height: 180 }} /></div></div></div>;
  if (setup.isError && session.isError) return <div className="auth-wrap"><div className="auth-panel"><div className="auth-card"><div className="auth-brand"><span className="brand-mark">BG</span><b>BHAI GARAGE</b></div><h1>Control plane unreachable</h1><p>The admin session and setup service did not answer. Your data has not been changed.</p><LoadError error={setup.error} retry={() => { setup.refetch(); session.refetch(); }} /></div></div></div>;
  const auth = session.data;
  if (auth?.authenticated) return <ProtectedApp />;
  const setupEnabled = !!setup.data?.setupEnabled || !setup.data?.configured;
  const isSetup = setupEnabled && (!setup.data?.configured || loc === '/setup');
  return <AuthScreen mode={isSetup ? 'setup' : 'login'} onSuccess={() => {
    queryClient.invalidateQueries({ queryKey: getGetAdminSessionQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetSetupStatusQueryKey() });
    setLoc('/');
  }} />;
}

function AuthScreen({ mode, onSuccess }: { mode: 'setup' | 'login'; onSuccess: () => void }) {
  const setupMutation = useSetupAdmin();
  const loginMutation = useLoginAdmin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [error, setError] = useState('');
  const isSetup = mode === 'setup';
  const pending = setupMutation.isPending || loginMutation.isPending;
  function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!email.trim() || !password) { setError('Enter your email and password to continue.'); return; }
    const onError = (err: unknown) => setError(errorMessage(err));
    if (isSetup) setupMutation.mutate({ data: { email: email.trim(), password, ...(setupToken ? { setupToken } : {}) } }, { onSuccess, onError });
    else loginMutation.mutate({ data: { email: email.trim(), password } }, { onSuccess, onError });
  }
  return <main className="auth-wrap">
    <section className="auth-art">
      <div className="auth-brand"><span className="brand-mark">BG</span><div><b className="brand-name">BHAI GARAGE</b><span className="brand-sub">OPERATOR CONTROL ROOM</span></div></div>
      <div className="auth-art-content"><div className="eyebrow" style={{ color: '#e0ad4c' }}>YOUR HOSTS. YOUR RULES.</div><h2>Infrastructure<br />under your<br />own roof.</h2><p>One clear view of the machines you own. Every number carries its source, every operation leaves a trail.</p></div>
      <div className="auth-art-footer">SELF-HOSTED VPS CONTROL PLANE&nbsp; / &nbsp;BUILD 01</div>
    </section>
    <section className="auth-panel"><div className="auth-card">
      <div className="auth-brand"><span className="brand-mark">BG</span><b>BHAI GARAGE</b></div>
      <div className="eyebrow">{isSetup ? 'INITIAL CONFIGURATION' : 'OPERATOR ACCESS'}</div>
      <h1>{isSetup ? 'Create your admin' : 'Welcome back'}</h1>
      <p>{isSetup ? 'Set up the first administrator for this control plane. Use a strong, unique password.' : 'Sign in to inspect your hosts and manage virtual machines.'}</p>
      <form onSubmit={submit}>
        {isSetup && <div className="form-field"><label htmlFor="setup-token">Setup token <span className="helper">(required; get it from the server operator)</span></label><input id="setup-token" className="field" autoComplete="off" required value={setupToken} onChange={e => setSetupToken(e.target.value)} placeholder="Paste setup token" data-testid="input-setup-token" /></div>}
        <div className="form-field"><label htmlFor="email">Email address</label><input id="email" className="field" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" data-testid="input-email" /></div>
        <div className="form-field"><label htmlFor="password">Password</label><input id="password" className="field" type="password" autoComplete={isSetup ? 'new-password' : 'current-password'} required minLength={isSetup ? 12 : 1} value={password} onChange={e => setPassword(e.target.value)} placeholder={isSetup ? 'At least 12 characters' : 'Your password'} data-testid="input-password" /></div>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <button className="button" style={{ width: '100%', marginTop: 7 }} disabled={pending} data-testid="button-auth-submit">{pending ? 'Working…' : isSetup ? 'Create administrator' : 'Sign in'} <ChevronRight size={14} /></button>
      </form>
      <div className="notice" style={{ marginTop: 22 }}>Session security is handled with an HttpOnly cookie. Credentials are sent only to this server.</div>
    </div></section>
  </main>;
}

function ProtectedApp() {
  const session = useGetAdminSession();
  const logout = useLogoutAdmin();
  const [location, setLocation] = useLocation();
  const nav = [
    { href: '/', label: 'Overview', icon: MonitorCog },
    { href: '/vps', label: 'VPS instances', icon: Server },
    { href: '/hosts', label: 'Hosts', icon: HardDrive },
    { href: '/activity', label: 'Activity', icon: Activity },
  ];
  const title = location.startsWith('/vps/') ? 'Instance detail' : nav.find(item => item.href === location)?.label ?? 'Control room';
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">BG</span><div><span className="brand-name">BHAI GARAGE</span><span className="brand-sub">OPERATOR CONTROL ROOM</span></div></div>
      <div className="nav-label">Workspace</div>
      <nav className="nav-links">{nav.map(item => {
        const Icon = item.icon;
        const active = item.href === '/' ? location === '/' : location === item.href || location.startsWith(item.href + '/');
        return <Link href={item.href} key={item.href} className={`nav-link${active ? ' active' : ''}`} data-testid={`link-nav-${item.label.toLowerCase().replaceAll(' ', '-')}`}><Icon /><span>{item.label}</span></Link>;
      })}</nav>
      <div className="side-bottom"><div className="host-mini"><div className="host-mini-title">Control plane</div><div className="host-mini-row"><span><i className="live-dot" />API status</span><span className="mono">active</span></div></div>
        <div className="user-box"><div className="user-avatar">{(session.data?.email || 'OP').slice(0, 2).toUpperCase()}</div><div style={{ minWidth: 0, flex: 1 }}><div className="user-email">{session.data?.email || 'Operator'}</div><div className="user-role">Administrator</div></div><button className="icon-button" aria-label="Sign out" title="Sign out" disabled={logout.isPending} onClick={() => logout.mutate(undefined, { onSuccess: auth => { queryClient.setQueryData(getGetAdminSessionQueryKey(), auth); setLocation('/'); } })} data-testid="button-logout"><LogOut size={15} /></button></div>
      </div>
    </aside>
    <div className="main-area"><header className="topbar"><span className="crumb">GARAGE&nbsp; / &nbsp;{title.toUpperCase()}</span><div className="top-actions"><span className="mode-tag">{session.data?.provisioner === 'simulation' ? 'Simulation environment' : 'Host telemetry'}</span><span className="mono" style={{ color: 'hsl(var(--muted-foreground))' }}>ADMIN</span></div></header>
      <Switch>
        <Route path="/" component={DashboardPage} />
        <Route path="/vps" component={VpsPage} />
        <Route path="/vps/:id" component={VpsDetailPage} />
        <Route path="/hosts" component={HostsPage} />
        <Route path="/activity" component={ActivityPage} />
        <Route component={NotFound} />
      </Switch>
    </div>
  </div>;
}

function DashboardPage() {
  const query = useGetDashboard();
  const health = useHealthCheck();
  const ready = useReadinessCheck();
  if (query.isLoading) return <main className="page"><div className="page-head"><div><div className="eyebrow">Fleet telemetry</div><h1>Overview</h1></div></div><LoadingCards /></main>;
  if (query.isError || !query.data) return <main className="page"><div className="page-head"><div><div className="eyebrow">Fleet telemetry</div><h1>Overview</h1></div></div><LoadError error={query.error} retry={() => query.refetch()} /></main>;
  const d = query.data, simulated = d.provider === 'simulation';
  const cp = d.resources.cpuUsagePercent || 0, memoryPct = d.resources.memoryTotalMb ? d.resources.memoryUsedMb / d.resources.memoryTotalMb * 100 : 0;
  const diskPct = d.resources.diskTotalGb ? d.resources.diskUsedGb / d.resources.diskTotalGb * 100 : 0;
  return <main className="page">
    <div className="page-head"><div><div className="eyebrow">Fleet telemetry&nbsp; / &nbsp;{simulated ? 'Simulator feed' : 'Reported host feed'}</div><h1>Good to see you, operator.</h1><p className="subtitle">The current shape of your infrastructure. State and resource data are labeled at source.</p></div><Link href="/vps" className="button"><Plus /> Provision a VPS</Link></div>
    {simulated && <div className="notice" style={{ marginBottom: 15 }}><strong>Simulation data:</strong> this fleet summary is generated by the development simulator, not reported by physical hosts. No simulated figure represents live host telemetry.</div>}
    <div className="stat-grid">
      <div className="panel stat-card"><div className="stat-label">Hosts online</div><div className="stat-value">{d.hosts.online}<span style={{ color: 'hsl(var(--muted-foreground))', fontSize: 16 }}> / {d.hosts.total}</span></div><div className="stat-note">Registered host agents</div></div>
      <div className="panel stat-card"><div className="stat-label">Instances running</div><div className="stat-value">{d.instances.running}<span style={{ color: 'hsl(var(--muted-foreground))', fontSize: 16 }}> / {d.instances.total}</span></div><div className="stat-note">{d.instances.stopped} stopped · {d.instances.failed} failed</div></div>
      <div className="panel stat-card"><div className="stat-label">CPU in use</div><div className="stat-value">{cp.toFixed(1)}<span style={{ fontSize: 17 }}>%</span></div><div className="stat-note"><Provenance simulation={simulated} /></div></div>
      <div className="panel stat-card"><div className="stat-label">Memory committed</div><div className="stat-value">{gb(d.resources.memoryUsedMb)}</div><div className="stat-note">of {gb(d.resources.memoryTotalMb)} · <Provenance simulation={simulated} /></div></div>
    </div>
    <div className="overview-grid">
      <section className="panel"><div className="panel-head"><div><div className="panel-title">Resource pressure</div><div className="panel-kicker" style={{ marginTop: 4 }}>{simulated ? 'Simulator-reported values' : 'Reported by registered hosts'}</div></div><Provenance simulation={simulated} /></div>
        <div className="resource-list">
          <ResourceMeter title="CPU utilization" value={cp} display={`${cp.toFixed(1)}%`} hint="Fleet aggregate" />
          <ResourceMeter title="Memory allocation" value={memoryPct} display={`${gb(d.resources.memoryUsedMb)} / ${gb(d.resources.memoryTotalMb)}`} hint={`${memoryPct.toFixed(1)}% committed`} amber />
          <ResourceMeter title="Disk allocation" value={diskPct} display={`${d.resources.diskUsedGb.toFixed(1)} / ${d.resources.diskTotalGb.toFixed(1)} GB`} hint={`${diskPct.toFixed(1)}% used`} />
        </div>
        <div className="mini-breakdown"><span><b><ArrowDownLeft size={12} style={{ verticalAlign: 'middle' }} /> {d.resources.networkRxMbps.toFixed(1)}</b> Mbps in</span><span><b><ArrowUpRight size={12} style={{ verticalAlign: 'middle' }} /> {d.resources.networkTxMbps.toFixed(1)}</b> Mbps out</span><Provenance simulation={simulated} /></div>
      </section>
      <section className="panel"><div className="panel-head"><div><div className="panel-title">Control plane checks</div><div className="panel-kicker" style={{ marginTop: 4 }}>Service reachability</div></div><ShieldCheck size={16} color="hsl(var(--primary))" /></div>
        <div className="quick-list">
          <div className="quick-row"><div className="quick-icon"><Signal /></div><div style={{ flex: 1 }}><div className="quick-name">API liveness</div><div className="quick-detail">/api/healthz</div></div><Status value={health.isLoading ? 'checking' : health.isError ? 'failed' : health.data?.status || 'unknown'} /></div>
          <div className="quick-row"><div className="quick-icon"><Check /></div><div style={{ flex: 1 }}><div className="quick-name">Service readiness</div><div className="quick-detail">/api/readyz</div></div><Status value={ready.isLoading ? 'checking' : ready.isError ? 'failed' : ready.data?.status || 'unknown'} /></div>
          <Link href="/hosts" className="quick-row"><div className="quick-icon"><HardDrive /></div><div style={{ flex: 1 }}><div className="quick-name">Host inventory</div><div className="quick-detail">{d.hosts.total} registered hosts</div></div><ChevronRight size={15} /></Link>
          <Link href="/activity" className="quick-row"><div className="quick-icon"><Activity /></div><div style={{ flex: 1 }}><div className="quick-name">Audit trail</div><div className="quick-detail">Review operator changes</div></div><ChevronRight size={15} /></Link>
        </div>
      </section>
    </div>
    <section className="panel"><div className="panel-head"><div><div className="panel-title">Recent activity</div><div className="panel-kicker" style={{ marginTop: 4 }}>Latest recorded control-plane events</div></div><Link href="/activity" className="source-line" style={{ textDecoration: 'none' }}>All events <ChevronRight size={13} /></Link></div>
      {d.recentActivity.length ? <div className="activity-list">{d.recentActivity.slice(0, 6).map(event => <ActivityRow event={event} key={event.id} />)}</div> : <Empty icon={<Activity />} title="Nothing recorded yet" detail="Lifecycle changes and host registrations will appear here." />}
    </section>
  </main>;
}
function ResourceMeter({ title, value, display, hint, amber = false }: { title: string; value: number; display: string; hint: string; amber?: boolean }) {
  const safe = Math.max(0, Math.min(100, value));
  return <div><div className="resource-head"><strong>{title}</strong><span>{display}</span></div><div className="meter"><div className={`meter-fill${amber ? ' amber' : ''}`} style={{ width: `${safe}%` }} /></div><div className="util-foot"><span>{hint}</span><span>{safe > 85 ? 'Near capacity' : 'Within range'}</span></div></div>;
}
function ActivityRow({ event }: { event: AuditEvent }) {
  return <div className="activity-row"><div className="activity-mark"><Activity size={11} /></div><div><div className="activity-text"><strong>{event.actor}</strong> {event.action.replaceAll('_', ' ')} <strong>{event.resourceType}{event.resourceId ? ` · ${event.resourceId}` : ''}</strong></div><div className="activity-meta">{Object.keys(event.details || {}).length ? JSON.stringify(event.details) : 'No additional detail'}</div></div><div className="activity-time">{ago(event.createdAt)}</div></div>;
}
function Empty({ icon, title, detail, action }: { icon: ReactNode; title: string; detail: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><strong>{title}</strong><p>{detail}</p>{action}</div>;
}

function VpsPage() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<VpsStatusFilter | 'all'>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const params = useMemo(() => ({ ...(search ? { search } : {}), ...(status !== 'all' ? { status } : {}) }), [search, status]);
  const query = useListVps(params);
  const hosts = useListHosts();
  const dashboard = useGetDashboard();
  const liveProvisioning = dashboard.data?.provider === 'libvirt';
  const create = useCreateVps();
  const qc = useQueryClient();
  const [formError, setFormError] = useState('');
  function createInstance(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setFormError('');
    const fd = new FormData(e.currentTarget);
    create.mutate({ data: {
      name: String(fd.get('name')), osImage: String(fd.get('osImage')) as 'ubuntu-24.04' | 'ubuntu-22.04' | 'debian-12' | 'rocky-9',
      vcpus: Number(fd.get('vcpus')), memoryMb: Number(fd.get('memoryMb')), diskGb: Number(fd.get('diskGb')),
      hostId: String(fd.get('hostId') || '') || null, sshPublicKey: String(fd.get('sshPublicKey') || '') || undefined,
    } }, { onSuccess: () => { qc.invalidateQueries({ queryKey: getListVpsQueryKey() }); qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); qc.invalidateQueries({ queryKey: getListAuditEventsQueryKey() }); setCreateOpen(false); }, onError: err => setFormError(errorMessage(err)) });
  }
  const items = query.data || [];
  return <main className="page">
    <div className="page-head"><div><div className="eyebrow">Compute inventory</div><h1>VPS instances</h1><p className="subtitle">Search the fleet, inspect allocation, and manage lifecycle operations.</p></div><button className="button" onClick={() => setCreateOpen(true)} data-testid="button-create-vps"><Plus /> Create instance</button></div>
    <div className="toolbar"><div className="search-wrap"><Search /><input className="field" type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by instance, host, or address…" data-testid="input-vps-search" /></div><select className="select" value={status} onChange={e => setStatus(e.target.value as VpsStatusFilter | 'all')} aria-label="Filter by status" data-testid="select-vps-status"><option value="all">All statuses</option>{['running','stopped','provisioning','failed','deleting'].map(s => <option value={s} key={s}>{s[0].toUpperCase()+s.slice(1)}</option>)}</select><span className="source-line">{query.isLoading ? '…' : `${items.length} results`}</span></div>
    <section className="panel">
      {query.isLoading ? <div style={{ padding: 18, display: 'grid', gap: 11 }}>{[0,1,2,3].map(n => <div className="skeleton" key={n} style={{ height: 44 }} />)}</div> : query.isError ? <div style={{ padding: 18 }}><LoadError error={query.error} retry={() => query.refetch()} /></div> : items.length ? <div className="table-wrap"><table><thead><tr><th>Instance</th><th>State</th><th>Host</th><th>Address</th><th>Allocation</th><th>Provider</th><th>Updated</th></tr></thead><tbody>{items.map(vps => <VpsRow vps={vps} key={vps.id} />)}</tbody></table></div> :
        <Empty icon={<Server />} title={search || status !== 'all' ? 'No matching instances' : 'No VPS instances yet'} detail={search || status !== 'all' ? 'Try another search or clear the status filter.' : 'Create an instance to begin building your fleet.'} action={!search && status === 'all' ? <button className="button button-small" onClick={() => setCreateOpen(true)}><Plus size={13} /> Create first instance</button> : undefined} />}
    </section>
    {createOpen && <Modal title="Create a VPS instance" subtitle={liveProvisioning ? "This request will be sent to a real KVM host. An SSH public key is required." : "Choose resources for a simulated development instance."} close={() => setCreateOpen(false)}>
      <form onSubmit={createInstance}>
        <div className="form-grid">
          <div className="form-field full"><label htmlFor="vps-name">Instance name</label><input id="vps-name" className="field" name="name" required minLength={2} maxLength={48} pattern="[a-zA-Z0-9][a-zA-Z0-9.-]*" placeholder="build-runner-01" data-testid="input-vps-name" /></div>
          <div className="form-field"><label htmlFor="os-image">OS image</label><select id="os-image" className="select" name="osImage"><option value="ubuntu-24.04">Ubuntu 24.04 LTS</option><option value="ubuntu-22.04">Ubuntu 22.04 LTS</option><option value="debian-12">Debian 12</option><option value="rocky-9">Rocky Linux 9</option></select></div>
          <div className="form-field"><label htmlFor="host-id">Target host</label><select id="host-id" className="select" name="hostId"><option value="">{liveProvisioning ? 'Automatic online KVM host' : 'Development simulator'}</option>{(hosts.data || []).filter(h => h.status === 'online' && (liveProvisioning ? !h.simulation : h.simulation)).map(h => <option value={h.id} key={h.id}>{h.name} · {h.hostname || h.id}</option>)}</select><span className="helper">{liveProvisioning ? 'Real VPS operations are queued to the selected host.' : 'This mode creates simulator-only data.'}</span></div>
          <div className="form-field"><label htmlFor="vcpus">vCPU cores</label><input id="vcpus" className="field" name="vcpus" type="number" min="1" max="32" defaultValue="2" required /></div>
          <div className="form-field"><label htmlFor="memory">Memory (MB)</label><input id="memory" className="field" name="memoryMb" type="number" min="512" max="262144" step="512" defaultValue="2048" required /></div>
          <div className="form-field"><label htmlFor="disk">Disk (GB)</label><input id="disk" className="field" name="diskGb" type="number" min="5" max="5000" defaultValue="40" required /></div>
          <div className="form-field full"><label htmlFor="ssh-key">SSH public key <span className="helper">{liveProvisioning ? '(required for real provisioning)' : '(optional in simulation)'}</span></label><textarea id="ssh-key" className="field" name="sshPublicKey" required={liveProvisioning} maxLength={8192} rows={3} placeholder="ssh-ed25519 AAAA… operator@device" style={{ resize: 'vertical' }} /></div>
        </div>
        {formError && <div className="auth-error">{formError}</div>}
        <div className="modal-foot" style={{ margin: '20px -22px -20px' }}><button type="button" className="button button-secondary" onClick={() => setCreateOpen(false)}>Cancel</button><button className="button" disabled={create.isPending} data-testid="button-submit-vps">{create.isPending ? 'Creating…' : 'Create instance'} <ChevronRight size={14} /></button></div>
      </form>
    </Modal>}
  </main>;
}
function VpsRow({ vps }: { vps: VpsInstance }) {
  const simulation = vps.provider === 'simulation';
  return <tr data-testid={`row-vps-${vps.id}`}><td><div className="instance-name"><span className="instance-glyph"><Server /></span><div><Link href={`/vps/${vps.id}`} className="name-link" data-testid={`link-vps-${vps.id}`}>{vps.name}</Link><div className="muted-cell">{vps.osImage}</div></div></div></td><td><Status value={vps.status} /></td><td>{vps.hostName || <span className="muted-cell">Unassigned</span>}</td><td className="muted-cell">{vps.ipAddress || '—'}</td><td className="muted-cell">{vps.vcpus} vCPU · {gb(vps.memoryMb)} · {vps.diskGb} GB</td><td><Provenance simulation={simulation} /></td><td className="muted-cell">{ago(vps.updatedAt)}</td></tr>;
}

function VpsDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const query = useGetVps(id);
  const op = useOperateVps();
  const del = useDeleteVps();
  const qc = useQueryClient();
  const [opError, setOpError] = useState('');
  function operate(action: 'start'|'stop'|'restart') {
    setOpError('');
    op.mutate({ id, data: { action } }, { onSuccess: () => { qc.invalidateQueries({ queryKey: getGetVpsQueryKey(id) }); qc.invalidateQueries({ queryKey: getListVpsQueryKey() }); qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); qc.invalidateQueries({ queryKey: getListAuditEventsQueryKey() }); }, onError: e => setOpError(errorMessage(e)) });
  }
  function remove() {
    if (!window.confirm('Delete this VPS instance? This operation cannot be undone.')) return;
    del.mutate({ id }, { onSuccess: () => { qc.invalidateQueries({ queryKey: getListVpsQueryKey() }); qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); qc.invalidateQueries({ queryKey: getListAuditEventsQueryKey() }); setLocation('/vps'); }, onError: e => setOpError(errorMessage(e)) });
  }
  if (query.isLoading) return <main className="page"><div className="skeleton" style={{ height: 280 }} /></main>;
  if (query.isError || !query.data) return <main className="page"><Link href="/vps" className="source-line" style={{ textDecoration: 'none', marginBottom: 20 }}><ArrowLeft size={13} /> Back to instances</Link><LoadError error={query.error} retry={() => query.refetch()} /></main>;
  const v = query.data, simulated = v.provider === 'simulation';
  return <main className="page">
    <div className="page-head"><div><Link href="/vps" className="source-line" style={{ textDecoration: 'none', marginBottom: 15, display: 'inline-flex' }}><ArrowLeft size={13} /> VPS inventory</Link><div className="eyebrow">Instance detail</div><h1>{v.name}</h1><p className="subtitle">Lifecycle and resource view for this virtual machine.</p></div><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><Status value={v.status} /><Provenance simulation={simulated} /></div></div>
    {simulated && <div className="notice" style={{ marginBottom: 15 }}>This instance is managed by the <strong>development simulator</strong>. Its status and usage metrics are not reported host telemetry.</div>}
    <div className="detail-grid">
      <section className="panel"><div className="detail-hero"><div><div className="instance-name"><span className="instance-glyph" style={{ width: 42, height: 42 }}><Server /></span><div><div style={{ fontWeight: 800, fontSize: 16 }}>{v.name}</div><div className="detail-id">INSTANCE&nbsp; / &nbsp;{v.id}</div></div></div></div><Provenance simulation={simulated} /></div>
        <div className="detail-stats"><div className="detail-stat"><span>CPU utilization</span><b>{v.cpuUsagePercent.toFixed(1)}%</b></div><div className="detail-stat"><span>Memory used</span><b>{gb(v.memoryUsedMb)} / {gb(v.memoryMb)}</b></div><div className="detail-stat"><span>Disk used</span><b>{v.diskUsedGb.toFixed(1)} / {v.diskGb} GB</b></div></div>
        <div className="resource-list"><ResourceMeter title="CPU" value={v.cpuUsagePercent} display={`${v.cpuUsagePercent.toFixed(1)}%`} hint="Current usage" /><ResourceMeter title="Memory" value={v.memoryMb ? v.memoryUsedMb / v.memoryMb * 100 : 0} display={`${gb(v.memoryUsedMb)} / ${gb(v.memoryMb)}`} hint="Current usage" amber /><div className="mini-breakdown" style={{ padding: 0 }}><span><b>{v.networkRxMbps.toFixed(2)}</b> Mbps in</span><span><b>{v.networkTxMbps.toFixed(2)}</b> Mbps out</span><Provenance simulation={simulated} /></div></div>
      </section>
      <section className="panel"><div className="panel-head"><div><div className="panel-title">Instance controls</div><div className="panel-kicker" style={{ marginTop: 4 }}>Lifecycle actions</div></div><Power size={16} color="hsl(var(--primary))" /></div>
        <div className="action-strip">{v.status === 'running' ? <><button className="button button-secondary" disabled={op.isPending} onClick={() => operate('restart')} data-testid="button-vps-restart"><RefreshCw size={14} /> Restart</button><button className="button button-danger" disabled={op.isPending} onClick={() => operate('stop')} data-testid="button-vps-stop"><Power size={14} /> Stop</button></> : <button className="button" disabled={op.isPending} onClick={() => operate('start')} data-testid="button-vps-start"><Power size={14} /> Start</button>}</div>
        {opError && <div className="auth-error" style={{ padding: '0 18px' }}>{opError}</div>}
        {(op.isPending || del.isPending) && <div className="source-line" style={{ padding: '0 18px 12px' }}>Sending lifecycle request…</div>}
        <div className="info-list">
          <Info label="Status"><Status value={v.status} /></Info><Info label="Provider"><Provenance simulation={simulated} /></Info><Info label="Operating system">{v.osImage}</Info><Info label="Host">{v.hostName || 'Not assigned'}</Info><Info label="IP address"><span className="mono">{v.ipAddress || 'Not assigned'}</span></Info><Info label="Resources">{v.vcpus} vCPU · {gb(v.memoryMb)} RAM · {v.diskGb} GB disk</Info><Info label="Created">{fmtDate(v.createdAt)}</Info><Info label="Last updated">{fmtDate(v.updatedAt)}</Info>
        </div>
        <div style={{ padding: '0 18px 17px' }}><button className="button button-danger button-small" onClick={remove} disabled={del.isPending} data-testid="button-vps-delete">Delete instance</button></div>
      </section>
    </div>
  </main>;
}
function Info({ label, children }: { label: string; children: ReactNode }) { return <div className="info-row"><span>{label}</span><strong>{children}</strong></div>; }

function HostsPage() {
  const query = useListHosts();
  const register = useRegisterHost();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false), [name, setName] = useState(''), [error, setError] = useState('');
  const [token, setToken] = useState<string | null>(null);
  function createHost(e: FormEvent) {
    e.preventDefault(); setError('');
    register.mutate({ data: { name: name.trim() } }, { onSuccess: result => { setToken(result.agentToken); setOpen(false); setName(''); qc.invalidateQueries({ queryKey: getListHostsQueryKey() }); qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); qc.invalidateQueries({ queryKey: getListAuditEventsQueryKey() }); }, onError: e => setError(errorMessage(e)) });
  }
  const hosts = query.data || [];
  return <main className="page">
    <div className="page-head"><div><div className="eyebrow">Host fleet</div><h1>Hosts</h1><p className="subtitle">Operator-owned Linux machines and their latest agent-reported telemetry.</p></div><button className="button" onClick={() => setOpen(true)} data-testid="button-register-host"><Plus /> Register host</button></div>
     <div className="source-line" style={{ marginBottom: 14 }}><i className="source-led" /> Host telemetry is reported by real agents or clearly labeled as simulation. Offline hosts retain their last-reported values.</div>
    {query.isLoading ? <div className="host-grid">{[0,1].map(i => <div className="panel skeleton" key={i} style={{ height: 220 }} />)}</div> : query.isError ? <LoadError error={query.error} retry={() => query.refetch()} /> : hosts.length ? <div className="host-grid">{hosts.map(h => <HostCard host={h} key={h.id} />)}</div> : <section className="panel"><Empty icon={<HardDrive />} title="No hosts registered" detail="Add a Linux host to begin reporting real machine telemetry." action={<button className="button button-small" onClick={() => setOpen(true)}><Plus size={13} /> Register first host</button>} /></section>}
    {open && <Modal title="Register a host" subtitle="Create an agent identity for a Linux machine you own." close={() => { setOpen(false); setError(''); }}>
      <form onSubmit={createHost}><div className="form-field"><label htmlFor="host-name">Host label</label><input id="host-name" className="field" value={name} onChange={e => setName(e.target.value)} minLength={2} maxLength={80} required placeholder="edge-node-01" data-testid="input-host-name" /><span className="helper">A recognizable name for this machine. Hostname and telemetry arrive from its agent.</span></div>{error && <div className="auth-error">{error}</div>}<div className="modal-foot" style={{ margin: '20px -22px -20px' }}><button type="button" className="button button-secondary" onClick={() => setOpen(false)}>Cancel</button><button className="button" disabled={register.isPending} data-testid="button-submit-host">{register.isPending ? 'Registering…' : 'Register host'}</button></div></form>
    </Modal>}
    {token && <Modal title="Agent token · shown once" subtitle="Copy this token now. It cannot be retrieved again from BHAI GARAGE." close={() => setToken(null)}>
      <div className="notice"><strong>Save it securely on the host</strong> as <code className="mono">BHAI_AGENT_TOKEN</code>. Do not put it in source control or a frontend setting.</div>
      <div className="token-box" data-testid="text-agent-token">{token}</div>
      <div className="modal-foot" style={{ margin: '0 -22px -20px' }}><button className="button button-secondary" onClick={() => { navigator.clipboard?.writeText(token).catch(() => undefined); setToken(null); }} data-testid="button-copy-token"><Clipboard size={14} /> Copy & close</button><button className="button" onClick={() => setToken(null)} data-testid="button-dismiss-token">I saved it</button></div>
    </Modal>}
  </main>;
}
function HostCard({ host }: { host: Host }) {
  const memPct = host.totalMemoryMb ? host.usedMemoryMb / host.totalMemoryMb * 100 : 0;
  const diskPct = host.diskTotalGb ? host.diskUsedGb / host.diskTotalGb * 100 : 0;
  return <section className="panel host-card" data-testid={`card-host-${host.id}`}>
    <div className="host-card-top"><div><div className="host-title">{host.name}</div><div className="host-hostname">{host.hostname || 'Hostname not reported'}</div><div style={{ marginTop: 6 }}><Provenance simulation={host.simulation} /></div></div><Status value={host.status} /></div>
    <div className="host-metrics"><div><div className="host-metric-label">CPU · {host.totalVcpus} vCPU</div><div className="host-metric-value">{host.cpuUsagePercent.toFixed(1)}%</div><div className="meter" style={{ marginTop: 8 }}><div className="meter-fill" style={{ width: `${Math.max(0, Math.min(100, host.cpuUsagePercent))}%` }} /></div></div><div><div className="host-metric-label">Memory · {gb(host.totalMemoryMb)}</div><div className="host-metric-value">{gb(host.usedMemoryMb)} <span className="helper">used</span></div><div className="meter" style={{ marginTop: 8 }}><div className="meter-fill amber" style={{ width: `${Math.max(0, Math.min(100, memPct))}%` }} /></div></div><div><div className="host-metric-label">Disk · {host.diskTotalGb} GB</div><div className="host-metric-value">{host.diskUsedGb.toFixed(1)} GB <span className="helper">used</span></div><div className="meter" style={{ marginTop: 8 }}><div className="meter-fill" style={{ width: `${Math.max(0, Math.min(100, diskPct))}%` }} /></div></div><div><div className="host-metric-label">Network throughput</div><div className="host-metric-value"><ArrowDownLeft size={12} /> {host.networkRxMbps.toFixed(2)} <ArrowUpRight size={12} /> {host.networkTxMbps.toFixed(2)}</div><div className="helper">Mbps in / out</div></div></div>
    <div className="host-card-foot"><span>Agent {host.agentVersion || 'unknown'}</span><span>Seen {ago(host.lastSeenAt)}</span></div>
  </section>;
}

function ActivityPage() {
  const [limit, setLimit] = useState(50);
  const query = useListAuditEvents({ limit });
  const events = query.data || [];
  return <main className="page">
    <div className="page-head"><div><div className="eyebrow">Change record</div><h1>Activity</h1><p className="subtitle">An auditable trail of admin operations, registrations, and lifecycle changes.</p></div><div className="source-line"><ShieldCheck size={14} /> Recorded by control plane</div></div>
    <div className="toolbar"><span className="source-line">Showing most recent {limit} events</span><select className="select" value={limit} onChange={e => setLimit(Number(e.target.value))} aria-label="Number of events"><option value={25}>25 events</option><option value={50}>50 events</option><option value={100}>100 events</option></select></div>
    <section className="panel"><div className="panel-head"><div className="panel-title">Audit events</div><div className="panel-kicker">Newest first</div></div>
      {query.isLoading ? <div style={{ padding: 18, display: 'grid', gap: 10 }}>{[0,1,2,3,4].map(i => <div className="skeleton" key={i} style={{ height: 40 }} />)}</div> : query.isError ? <div style={{ padding: 18 }}><LoadError error={query.error} retry={() => query.refetch()} /></div> : events.length ? <div className="activity-list">{events.map(event => <AuditDetail event={event} key={event.id} />)}</div> : <Empty icon={<Activity />} title="No audit events" detail="Actions will be recorded here as you operate the control plane." />}
    </section>
  </main>;
}
function AuditDetail({ event }: { event: AuditEvent }) {
  return <article className="activity-row"><div className="activity-mark"><Terminal size={11} /></div><div><div className="activity-text"><strong>{event.actor}</strong> {event.action.replaceAll('_',' ')} <strong>{event.resourceType}</strong></div><div className="activity-meta">Resource {event.resourceId || '—'} · {JSON.stringify(event.details || {})}</div></div><div className="activity-time">{fmtDate(event.createdAt)}</div></article>;
}

function Modal({ title, subtitle, children, close }: { title: string; subtitle: string; children: ReactNode; close: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}><section className="modal" role="dialog" aria-modal="true" aria-label={title}><div className="modal-head"><div><h2>{title}</h2><div className="subtitle" style={{ marginTop: 5, fontSize: 10 }}>{subtitle}</div></div><button className="icon-button" onClick={close} aria-label="Close dialog"><X size={17} /></button></div><div className="modal-body">{children}</div></section></div>;
}
function Router() {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}><Switch>
    <Route path="/setup"><AuthGate /></Route>
    <Route><AuthGate /></Route>
  </Switch></ErrorBoundary>;
}
function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}
export default App;
