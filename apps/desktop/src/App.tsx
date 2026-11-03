import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity, ArrowDownLeft, ArrowRight, Check, ChevronDown, Clipboard,
  Globe2, Info, LoaderCircle, Moon, Sun, Monitor, Network, PanelsTopLeft,
  Plus, Search, Settings2, ShieldCheck, Square, Trash2, Wifi, X, Download,
} from 'lucide-react';
import { api, emptyState, errorMessage, isBrowserPreview } from './api';
import { updateNetworkField } from './network-settings';
import type { AppState, Device, DiscoveredHost, HostInfo, NetworkSettings, UpdateState } from './types';
import Session from './Session';
import MacPermissions from './MacPermissions';

type Page = 'devices' | 'network' | 'activity' | 'updates';
type Notice = { text: string; kind: 'success' | 'error' };

const routeNames = { direct: 'Direct connection', tailscale: 'Tailscale', relay: 'Relay connection' };
const dateText = (value?: string) => {
  if (!value) return 'Never connected';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Recently connected';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
};

function Spinner() { return <LoaderCircle className="spin" size={16} aria-hidden="true" />; }

export default function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const saved = localStorage.getItem('remoter-theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch { /* Use the system theme when storage is unavailable. */ }
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  useLayoutEffect(() => {
    document.documentElement.style.colorScheme = theme;
    try { localStorage.setItem('remoter-theme', theme); } catch { /* The toggle still works without persistence. */ }
  }, [theme]);
  useEffect(() => { void api.setTheme(theme).catch(() => {}); }, [theme]);
  const [state, setState] = useState<AppState>(emptyState);
  const [page, setPage] = useState<Page>('devices');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [removeDevice, setRemoveDevice] = useState<Device | null>(null);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [session, setSession] = useState<{ device: Device; info: HostInfo } | null>(null);
  const [sessionPanel, setSessionPanel] = useState<'network' | 'updates' | null>(null);
  const noticeTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const announcedUpdate = useRef('');

  const notify = useCallback((text: string, kind: Notice['kind'] = 'success') => {
    clearTimeout(noticeTimeout.current);
    setNotice({ text, kind });
    noticeTimeout.current = setTimeout(() => setNotice(null), kind === 'error' ? 11000 : 4500);
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setLoadError('');
    try {
      const next = await api.getState();
      setState(next);
      if (next.updateRestoreError) notify(next.updateRestoreError, 'error');
      const device = next.devices.find(item => item.id === next.restoredDeviceId);
      if (device) {
        // A host being updated at the same time may need a moment to return.
        let lastError: unknown;
        for (let attempt = 0; attempt < 10; attempt++) {
          try {
            const info = await api.connect(device.id);
            if (!info.capabilities.capture || !info.displays.length) throw new Error('The host cannot share a display.');
            setSession({ device, info });
            lastError = undefined;
            break;
          } catch (error) { lastError = error; if (attempt < 9) await new Promise(resolve => setTimeout(resolve, 1500)); }
        }
        if (lastError) notify(`Could not restore the session: ${errorMessage(lastError)}`, 'error');
      }
    }
    catch (error) { setLoadError(errorMessage(error)); }
    finally { setLoading(false); }
  }, [notify]);

  useEffect(() => { void load(); return () => clearTimeout(noticeTimeout.current); }, [load]);
  useEffect(() => {
    if (isBrowserPreview) return;
    let active = true;
    const timer = setInterval(async () => {
      try {
        const update = await api.getUpdates();
        if (active && update.phase === 'ready' && update.availableVersion !== announcedUpdate.current) {
          announcedUpdate.current = update.availableVersion ?? '';
          notify(`Remoter ${update.availableVersion} is ready. Open Updates to install anytime.`);
        }
      } catch { /* The Updates page displays check and download failures. */ }
    }, 2500);
    return () => { active = false; clearInterval(timer); };
  }, [notify]);
  useEffect(() => {
    if (!state.hostRunning) return;
    let active = true;
    const timer = setInterval(async () => {
      try {
        const next = await api.getState();
        if (active && !next.hostRunning) { setState(next); notify('This computer stopped sharing.'); }
      } catch { /* Existing operation errors are shown where the action happens. */ }
    }, 2500);
    return () => { active = false; clearInterval(timer); };
  }, [state.hostRunning, notify]);

  async function connect(device: Device) {
    setBusy(`connect:${device.id}`);
    try {
      const info = await api.connect(device.id);
      if (!info.capabilities.capture || !info.displays.length) {
        await api.disconnect(device.id);
        throw new Error('This host cannot share a display yet. Check its screen capture permissions.');
      }
      setSession({ device, info });
      setNotice(null);
      setState(await api.getState());
    } catch (error) { notify(errorMessage(error), 'error'); }
    finally { setBusy(''); }
  }

  async function test(device: Device) {
    setBusy(`test:${device.id}`);
    try {
      const info = await api.testDevice(device.id);
      setState((previous) => ({ ...previous, devices: previous.devices.map((item) => item.id === device.id ? { ...item, status: 'ready' } : item) }));
      notify(`${info.name} is reachable. ${info.displays.length} ${info.displays.length === 1 ? 'display' : 'displays'} available.`);
    } catch (error) {
      setState((previous) => ({ ...previous, devices: previous.devices.map((item) => item.id === device.id ? { ...item, status: 'offline' } : item) }));
      notify(errorMessage(error), 'error');
    } finally { setBusy(''); }
  }

  async function disconnect() {
    if (!session) return;
    setBusy('disconnect');
    try { setState(await api.disconnect(session.device.id)); }
    catch (error) { notify(errorMessage(error), 'error'); }
    finally { setSession(null); setBusy(''); }
  }

  const filtered = state.devices.filter((device) => `${device.name} ${device.endpoint}`.toLowerCase().includes(query.toLowerCase()));

  return <div className={`app-shell${session ? ' in-session' : ''}`}>
    <header className="app-header">
      <a href="#" className="brand" onClick={(event) => { event.preventDefault(); if (!session) setPage('devices'); }} aria-label="Remoter home">
        <span className="brand-mark"><PanelsTopLeft size={20} strokeWidth={1.8} /></span><span>Remoter</span>
      </a>
      <nav className="main-nav" aria-label="Main navigation">
        {([{ key: 'devices', label: 'Devices', icon: Monitor }, { key: 'network', label: 'Options', icon: Settings2 }, { key: 'activity', label: 'Activity', icon: Activity }, { key: 'updates', label: 'Updates', icon: Download }] as const).filter(({ key }) => !session || key === 'network' || key === 'updates').map(({ key, label, icon: Icon }) =>
          <button key={key} className={`nav-item${(!session && page === key) || sessionPanel === key ? ' active' : ''}`} aria-current={!session && page === key ? 'page' : undefined} onClick={() => { if (session && (key === 'network' || key === 'updates')) setSessionPanel(key); else setPage(key); }}><Icon size={16} />{label}</button>,
        )}
      </nav>
      <button className="icon-button theme-toggle" role="switch" aria-checked={theme === 'dark'} aria-label="Dark mode" title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</button>
    </header>

    {isBrowserPreview && <div className="preview-banner"><Info size={14} /><span>Browser preview · Device connections and screen sharing are available in the desktop app.</span></div>}

    {session ? <Session device={session.device} info={session.info} network={state.network} disconnecting={busy === 'disconnect'} onDisconnect={disconnect} /> :
      <main className="main-content">
        {loading ? <div className="loading-state"><Spinner /><span>Loading…</span></div> : loadError ?
          <div className="empty-state"><Info size={26} /><h1>Couldn’t load devices</h1><p>{loadError}</p><button className="button primary" onClick={() => void load()}>Try again</button></div> : <>
            {page === 'devices' && <>
              <div className="page-heading"><div><h1>Devices</h1></div><button className="button primary" onClick={() => setShowAdd(true)}><Plus size={16} />Add device</button></div>
              {state.devices.length > 0 ? <>
                <div className="directory-toolbar"><label className="search-field"><Search size={16} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a device…" aria-label="Search devices" /></label><span className="count-label">{state.devices.length} {state.devices.length === 1 ? 'device' : 'devices'}</span></div>
                <div className="device-list">
                  <div className="device-table-heading" aria-hidden="true"><span>Device</span><span>Status</span><span>Last connected</span><span /></div>
                  {filtered.map((device) => <div className="device-row" key={device.id}>
                    <div className="device-identity"><span className="device-icon"><Monitor size={22} strokeWidth={1.5} /></span><div><span className="device-name">{device.name}</span><span className="device-address" title={device.endpoint}>{device.endpoint}</span></div></div>
                    <div className={`device-status ${device.status ?? 'unknown'}`}><span />{device.status === 'ready' ? 'Reachable' : device.status === 'offline' ? 'Unavailable' : 'Not checked'}</div>
                    <div className="last-connected">{dateText(device.lastConnectedAt)}</div>
                    <div className="device-actions"><button className="icon-button" title="Check connection" aria-label={`Check connection to ${device.name}`} disabled={!!busy} onClick={() => void test(device)}>{busy === `test:${device.id}` ? <Spinner /> : <Wifi size={16} />}</button><button className="icon-button remove-device" title="Remove device" aria-label={`Remove ${device.name}`} disabled={!!busy} onClick={() => setRemoveDevice(device)}><Trash2 size={16} /></button><button className="button small" disabled={!!busy} onClick={() => void connect(device)}>{busy === `connect:${device.id}` ? <Spinner /> : null}Connect<ArrowUpRightIcon /></button></div>
                  </div>)}
                  {!filtered.length && <div className="search-empty"><Search size={22} /><p>No devices match “{query}”.</p><button className="text-button" onClick={() => setQuery('')}>Clear search</button></div>}
                </div>
              </> : <div className="onboarding-empty">
                <div className="empty-illustration" aria-hidden="true"><div className="illustration-back" /><div className="illustration-front"><Monitor size={35} strokeWidth={1.3} /><span className="illustration-plus"><Plus size={14} /></span></div></div>
                <h2>No devices added</h2><p>Add a computer using its sharing invitation.</p>
                <button className="button" onClick={() => setShowAdd(true)}>Add a device<ArrowRight size={15} /></button>
              </div>}
              <HostPanel state={state} updateState={setState} notify={notify} />
            </>}

            {page === 'network' && <NetworkPanel network={state.network} onSave={async (settings) => { const next = await api.saveNetwork(settings); setState(next); notify(isBrowserPreview ? 'Preview settings updated. Nothing was saved to your system.' : 'Connection settings saved.'); }} />}
            {page === 'updates' && <UpdatesPanel />}

            {page === 'activity' && <>
              <div className="page-heading"><div><h1>Activity</h1></div><span className="quiet-label">Stored on this computer</span></div>
              {state.activity.length ? <div className="activity-list">{[...state.activity].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).map((item) => <div className="activity-row" key={item.id}><div className="activity-icon"><ArrowDownLeft size={17} /></div><div className="activity-description"><strong>{item.deviceName || 'This computer'}</strong><span>{item.action}</span></div><time dateTime={item.at}>{dateText(item.at)}</time></div>)}</div> : <div className="empty-state activity-empty"><div className="empty-icon"><Activity size={26} strokeWidth={1.4} /></div><h2>No activity yet</h2><button className="text-button" onClick={() => setPage('devices')}>Go to devices<ArrowRight size={14} /></button></div>}
            </>}
          </>}
      </main>}

    {!session && <footer className="app-footer"><span><span className="footer-route-dot" />{state.network.proxyEnabled ? 'SOCKS5 proxy' : routeNames[state.network.mode]}</span></footer>}

    {session && sessionPanel && <Modal title={sessionPanel === 'network' ? 'Options' : 'Updates'} onClose={() => setSessionPanel(null)}><div className="session-settings">
      {sessionPanel === 'network' ? <NetworkPanel network={state.network} locked onSave={async () => {}} /> : <UpdatesPanel />}
    </div></Modal>}

    {notice && <div className={`toast ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.kind === 'success' ? <Check size={17} /> : <Info size={17} />}<span>{notice.text}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={15} /></button></div>}

    {showAdd && <AddDeviceModal platform={state.platform} onClose={() => setShowAdd(false)} onLAN={async (id) => { const result = await api.addLANDevice(id); setState(result.state); setShowAdd(false); await connect(result.state.devices.find(device => device.id === result.deviceId)!); }} onAdd={async (invitation) => { setState(await api.addDevice(invitation)); setShowAdd(false); notify('Device added.'); }} />}
    {removeDevice && <Modal title="Remove device?" onClose={() => !busy && setRemoveDevice(null)} busy={!!busy}>
      <p className="modal-description"><strong>{removeDevice.name}</strong> will be removed. Its host will keep running.</p>
      <div className="modal-actions"><button className="button" disabled={!!busy} onClick={() => setRemoveDevice(null)}>Cancel</button><button className="button danger" disabled={!!busy} onClick={async () => { setBusy('remove'); try { setState(await api.removeDevice(removeDevice.id)); setRemoveDevice(null); notify('Device removed.'); } catch (error) { notify(errorMessage(error), 'error'); } finally { setBusy(''); } }}>{busy === 'remove' ? <Spinner /> : <Trash2 size={15} />}Remove device</button></div>
    </Modal>}
  </div>;
}

function ArrowUpRightIcon() { return <ArrowRight className="connect-arrow" size={14} />; }

function UpdatesPanel() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [error, setError] = useState('');
  const [installing, setInstalling] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = async () => { try { const next = await api.getUpdates(); if (active) setState(next); } catch (e) { if (active) setError(errorMessage(e)); } };
    void refresh(); const timer = setInterval(() => void refresh(), 1000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const busy = state?.phase === 'checking' || state?.phase === 'downloading' || state?.phase === 'verifying';
  const downloadVisible = state?.availableVersion && ['downloading', 'verifying', 'ready'].includes(state.phase);
  const megabytes = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return <>
    <div className="page-heading"><div><h1>App updates</h1></div></div>
    <section className="settings-section" aria-label="App updates">
      <div className="settings-heading"><h2>Remoter {state?.currentVersion ?? ''}</h2><p>Checks Jack PC, GPD PC, and GitHub. Matching LAN downloads are preferred.</p></div>
      <p role="status">{installing ? 'Starting the installer… Remoter will restart when it is ready.' : state?.message ?? 'Loading update status…'}</p>
      {state?.availableVersion && <p className="field-help">Version {state.availableVersion}{state.source ? ` · ${state.source}` : ''}</p>}
      {downloadVisible && <div className="update-download">
        <div className="update-download-label"><span>{state.phase === 'ready' ? 'Download complete' : state.phase === 'verifying' ? 'Verifying download…' : 'Downloading update…'}</span><span>{state.progress ?? 0}%</span></div>
        <progress aria-label="Update download" value={state.progress ?? 0} max={100} />
        {state.totalBytes !== undefined && <p className="field-help">{megabytes(state.downloadedBytes ?? 0)} of {megabytes(state.totalBytes)}</p>}
      </div>}
      {state?.notes && <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7, marginTop: 20 }}>{state.notes}</p>}
      <p className="field-help" style={{ marginTop: 16 }}>Install anytime, including while sharing or controlling a computer. Remoter updates and reopens automatically, then restores sharing and your session. Connections pause briefly during the restart. Your paired devices and settings are kept.</p>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="settings-actions">
        <button className="button" disabled={!state || busy || installing || state.phase === 'unsupported'} onClick={async () => { setError(''); try { setState(await api.checkUpdates()); } catch (e) { setError(errorMessage(e)); } }}>{busy ? <Spinner /> : <Download size={15} />}Check for updates</button>
        <button className="button primary" disabled={state?.phase !== 'ready' || installing} onClick={async () => { setInstalling(true); setError(''); try { await api.installUpdate(); } catch (e) { setError(errorMessage(e)); setInstalling(false); } }}>{installing ? <Spinner /> : <Download size={15} />}Install update</button>
      </div>
    </section>
  </>;
}

function Modal({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; if (dialog && !dialog.open) dialog.showModal(); return () => dialog?.close(); }, []);
  return <dialog className="modal" ref={ref} aria-labelledby="modal-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) { const box = event.currentTarget.getBoundingClientRect(); if (!busy && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) onClose(); } }}><div className="modal-heading"><h2 id="modal-title">{title}</h2><button className="icon-button" aria-label="Close dialog" disabled={busy} onClick={onClose}><X size={19} /></button></div>{children}</dialog>;
}

function AddDeviceModal({ platform, onClose, onAdd, onLAN }: { platform?: string; onClose: () => void; onAdd: (invitation: string) => Promise<void>; onLAN: (id: string) => Promise<void> }) {
  const [invitation, setInvitation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [hosts, setHosts] = useState<DiscoveredHost[]>([]);
  const [scanning, setScanning] = useState(true);
  const [scanError, setScanError] = useState('');
  async function scan() {
    setScanning(true); setScanError('');
    try { setHosts(await api.discoverLAN()); } catch (error) { setScanError(errorMessage(error)); }
    finally { setScanning(false); }
  }
  useEffect(() => { void scan(); }, []);
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(''); try { await onAdd(invitation.trim()); } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); } }
  return <Modal title="Add a device" onClose={onClose} busy={busy}>
    {platform === 'darwin' && <div className="local-network-help">
      <p className="field-help">Allow Remoter in System Settings → Privacy &amp; Security → Local Network to connect to nearby computers. If you change access, quit and reopen Remoter.</p>
      <button className="button small" disabled={busy} onClick={async () => { try { await api.openLocalNetworkSettings(); } catch (error) { setError(errorMessage(error)); } }}>Open Local Network settings</button>
    </div>}
    <section className="lan-discovery" aria-label="Nearby computers">
      <div className="lan-discovery-heading"><strong><Wifi size={16} />Nearby computers</strong><button className="button small" disabled={busy || scanning} onClick={() => void scan()}>{scanning ? <Spinner /> : <Search size={14} />}{scanning ? 'Searching…' : 'Scan again'}</button></div>
      <p className="field-help">Start sharing on the other PC. Enable “Easy LAN connections” there for one-click access.</p>
      <div aria-live="polite">{!scanning && !hosts.length && !scanError && <p className="field-help">No computers found. Check that both PCs are on the same LAN and that UDP port 45781 is allowed.</p>}{scanError && <p className="inline-error">{scanError}</p>}</div>
      {hosts.map(host => <div className="lan-host" key={host.id}><Monitor size={19} /><div><strong>{host.name}</strong><span>{host.endpoint}</span></div><button className="button small" disabled={busy || !host.easy} title={host.easy ? 'Add and connect to this computer' : 'Enable Easy LAN connections on this host, or paste its invitation below'} onClick={async () => { setBusy(true); setError(''); try { await onLAN(host.id); } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); } }}>{host.easy ? 'Add & connect' : 'Invitation required'}</button></div>)}
    </section>
    <form onSubmit={submit}><label className="field-label" htmlFor="device-invitation">Device invitation</label><textarea id="device-invitation" className="invitation-input" rows={3} disabled={busy} value={invitation} onChange={(event) => setInvitation(event.target.value)} placeholder="Or paste an invitation…" spellCheck={false} autoComplete="off" required /><div className="field-help"><ShieldCheck size={14} /><span>Use an invitation for Tailscale, relay, or hosts with easy LAN access off.</span></div>{error && <div className="inline-error" role="alert"><Info size={16} />{error}</div>}<div className="modal-actions"><button className="button" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="button primary" type="submit" disabled={!invitation.trim() || busy}>{busy ? <Spinner /> : <Plus size={16} />}Add device</button></div></form></Modal>;
}

function HostPanel({ state, updateState, notify }: { state: AppState; updateState: (state: AppState) => void; notify: (text: string, kind?: Notice['kind']) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [allowInput, setAllowInput] = useState(true);
  const [discover, setDiscover] = useState(true);
  const [easyLAN, setEasyLAN] = useState(false);
  const [allowClipboard, setAllowClipboard] = useState(false);
  const [allowAudio, setAllowAudio] = useState(false);
  const [listen, setListen] = useState(state.hostSuggestedListen ?? '127.0.0.1:45780');
  const [advertise, setAdvertise] = useState(state.hostSuggestedEndpoint ?? 'https://127.0.0.1:45780');
  const [advanced, setAdvanced] = useState(false);
  const [invitation, setInvitation] = useState(state.hostInvitation ?? '');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (state.hostInvitation) setInvitation(state.hostInvitation); }, [state.hostInvitation]);
  async function toggleHost() {
    setBusy(true);
    try {
      if (state.hostRunning) { await api.stopHost(); setInvitation(''); notify('Sharing stopped.'); }
      else { const result = await api.startHost({ allowInput, discover, easyLAN, allowClipboard, allowAudio, listen: listen.trim(), advertise: advertise.trim() }); setInvitation(result.invitation); setExpanded(true); notify('This computer is ready to share.'); }
      updateState(await api.getState());
    } catch (error) { notify(errorMessage(error), 'error'); }
    finally { setBusy(false); }
  }
  return <section className={`host-panel${expanded ? ' expanded' : ''}`} aria-label="Share this computer">
    <div className="host-summary"><div className="host-icon"><Monitor size={20} strokeWidth={1.6} /></div><div className="host-title"><h2>This computer <span className={`host-badge${state.hostRunning ? ' sharing' : ''}`}>{state.hostRunning ? 'Sharing' : 'Not sharing'}</span></h2></div><button className="button small" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{expanded ? 'Hide details' : 'Set up sharing'}<ChevronDown size={15} className={expanded ? 'rotate' : ''} /></button></div>
    {expanded && <div className="host-details">
      {state.platform === 'darwin' && <MacPermissions sharing={state.hostRunning} />}
      {!state.hostRunning && <fieldset className="sharing-options" disabled={busy}><legend>Sharing permissions</legend>
        <label className="check-label"><input type="checkbox" checked={discover} onChange={event => { setDiscover(event.target.checked); if (!event.target.checked) setEasyLAN(false); }} />Show this PC in LAN discovery</label>
        <label className="check-label"><input type="checkbox" checked={easyLAN} onChange={event => { setEasyLAN(event.target.checked); if (event.target.checked) setDiscover(true); }} />Easy LAN connections</label>
        <p className="field-help">Anyone on this PC’s private LAN can connect without an invitation while this is enabled. Stop sharing to revoke LAN access.</p>
        <label className="check-label"><input type="checkbox" disabled={state.platform === 'darwin'} checked={allowClipboard} onChange={event => setAllowClipboard(event.target.checked)} />Allow two-way text clipboard{state.platform === 'darwin' ? ' (Windows host)' : ''}</label>
        <label className="check-label"><input type="checkbox" disabled={state.platform === 'darwin'} checked={allowAudio} onChange={event => setAllowAudio(event.target.checked)} />Allow system audio (Windows host)</label>
      </fieldset>}
      <div className="host-controls"><div>{state.hostRunning ? <span className="check-label"><ShieldCheck size={14} />Sharing is enabled</span> : <label className="check-label"><input type="checkbox" checked={allowInput} disabled={busy} onChange={(event) => setAllowInput(event.target.checked)} /><span>Allow keyboard and mouse control</span></label>}<p className="field-help">{state.hostRunning ? 'Stop sharing to change access permissions.' : 'Keep this off to share your screen in view-only mode.'}</p></div><button className={`button ${state.hostRunning ? '' : 'primary'}`} disabled={busy} onClick={() => void toggleHost()}>{busy ? <Spinner /> : state.hostRunning ? <Square size={14} /> : <ArrowUpRightIcon />}{state.hostRunning ? 'Stop sharing' : 'Start sharing'}</button></div>
      {state.platform !== 'darwin' && <><label className="check-label"><input type="checkbox" checked={state.launchOnBoot === true} disabled={busy || !state.startupSupported || (!state.hostRunning && !state.launchOnBoot)} onChange={async event => {
        const enabled = event.target.checked; setBusy(true);
        try { updateState(await api.setLaunchOnBoot(enabled)); notify(enabled ? 'Launch on boot enabled. Sharing will resume after Windows sign-in.' : 'Launch on boot disabled.'); }
        catch (error) { notify(errorMessage(error), 'error'); }
        finally { setBusy(false); }
      }} />Launch on boot</label>
      <p className="field-help">{!state.startupSupported ? 'Available in the Windows release.' : !state.hostRunning && !state.launchOnBoot ? 'Start sharing first to save your startup permissions.' : 'Starts in the tray after Windows sign-in with saved sharing permissions. Closing the window keeps it running; quit from the tray. Stop sharing clears automatic sharing.'}</p></>}
      {!state.hostRunning && <><p className="field-help">{advertise.includes('://127.') || advertise.includes('://localhost') || advertise.includes('://[::1]') ? 'Local testing only. Set a LAN or Tailscale address in connection details to reach this computer remotely.' : `Host address: ${advertise}`}</p><button className="text-button advanced-toggle" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}><Settings2 size={13} />Connection details<ChevronDown size={13} className={advanced ? 'rotate' : ''} /></button>{advanced && <div className="host-advanced"><label className="field-label">Listen address<input className="text-input" value={listen} onChange={(event) => setListen(event.target.value)} placeholder="192.168.1.20:45780" spellCheck={false} disabled={busy} /></label><label className="field-label">Address in invitation<input className="text-input" value={advertise} onChange={(event) => setAdvertise(event.target.value)} placeholder="https://192.168.1.20:45780" spellCheck={false} disabled={busy} /><span className="field-help">Use a LAN or Tailscale HTTPS address your other computer can reach.</span></label></div>}</>}
      {state.hostRunning && <div className="host-invitation"><div><span className="field-label">Your invitation</span><p className="field-help">{invitation ? 'Copy this to Remoter on your other computer. Anyone with it can connect.' : 'Restart sharing to retrieve its invitation.'}</p></div><button className="button small" disabled={!invitation} onClick={async () => { try { await api.copy(invitation); setCopied(true); setTimeout(() => setCopied(false), 2200); } catch (error) { notify(errorMessage(error), 'error'); } }}>{copied ? <Check size={15} /> : <Clipboard size={15} />}{copied ? 'Copied' : 'Copy invitation'}</button></div>}
    </div>}
  </section>;
}

function NetworkPanel({ network, onSave, locked = false }: { network: NetworkSettings; onSave: (settings: NetworkSettings) => Promise<void>; locked?: boolean }) {
  const [draft, setDraft] = useState<NetworkSettings>({ ...network });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const persistedSignature = JSON.stringify(network);
  useEffect(() => setDraft({ ...network }), [persistedSignature]);
  function update<K extends keyof NetworkSettings>(key: K, value: NetworkSettings[K]) {
    setDraft((previous) => updateNetworkField(previous, key, value));
  }
  async function save(event: FormEvent) {
    if (locked) { event.preventDefault(); return; }
    event.preventDefault(); setBusy(true); setError('');
    try { await onSave(draft); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <>
    <div className="page-heading"><div><h1>Connection settings</h1></div></div>
    {locked && <p className="settings-note"><Info size={14} />Disconnect before changing connection settings.</p>}
    <form className="network-form" onSubmit={save} aria-busy={busy}>
      <fieldset className="settings-fieldset" disabled={busy || locked}>
        <legend className="sr-only">Connection preferences</legend>
        <section className="settings-section">
          <div className="settings-heading"><h2>Connection route</h2></div>
          <div className="route-options" role="radiogroup" aria-label="Connection route">
            {([
              { value: 'direct', title: 'Direct', detail: 'Local network or reachable address', icon: Wifi },
              { value: 'tailscale', title: 'Tailscale', detail: 'Through your installed Tailscale client', icon: Network },
              { value: 'relay', title: 'Relay', detail: 'Through your own relay server', icon: Globe2 },
            ] as const).map(({ value, title, detail, icon: Icon }) =>
              <label className={`route-card${draft.mode === value ? ' selected' : ''}`} key={value}>
                <input type="radio" name="route" value={value} checked={draft.mode === value} onChange={() => update('mode', value)} />
                <div className="route-card-top"><Icon size={19} strokeWidth={1.6} /><span className="radio-indicator">{draft.mode === value && <span />}</span></div>
                <strong>{title}</strong><span>{detail}</span>
              </label>,
            )}
          </div>
          {draft.mode === 'tailscale' && <p className="settings-note"><Info size={14} />Both computers need Tailscale running. Add the device using its Tailscale address. Tailscale manages its own proxy settings.</p>}
        </section>

        {draft.mode === 'relay' && <section className="settings-section">
          <div className="settings-heading"><h2>Relay overrides <span className="optional-inline">Optional</span></h2><p>Leave these blank to use the relay details in each device’s invitation.</p></div>
          <div className="settings-fields">
            <label className="field-label full-width">Relay address
              <input className="text-input" placeholder="From device invitation · or wss://relay.example.com" value={draft.relayUrl} onChange={(event) => update('relayUrl', event.target.value)} type="url" spellCheck={false} />
            </label>
            <label className="field-label">Device ID override <span className="optional">All connections</span>
              <input className="text-input" placeholder="Use each device’s own ID" value={draft.relayDeviceId} onChange={(event) => update('relayDeviceId', event.target.value)} spellCheck={false} aria-describedby="relay-id-help" />
            </label>
            <div>
              <label className="field-label">Relay token override
                <input className="text-input" type="password" autoComplete="new-password" placeholder={draft.relayTokenSaved ? 'Saved · enter to replace' : 'Use the device invitation token'} value={draft.relayToken} onChange={(event) => update('relayToken', event.target.value)} />
              </label>
              {(draft.relayTokenSaved || draft.relayToken) && <button className="text-button clear-secret" type="button" onClick={() => setDraft((previous) => ({ ...previous, relayToken: '', relayTokenSaved: false }))}><X size={12} />Clear token override</button>}
            </div>
          </div>
          <p className="settings-note" id="relay-id-help"><Info size={14} />A device ID override sends every connection to that one relay device. Leave it blank when managing multiple computers. Changing the relay address or ID clears its saved token.</p>
        </section>}

        <section className="settings-section">
          <div className="settings-heading inline-heading">
            <div><h2>SOCKS5 proxy</h2><p>Route outbound connections through a proxy server.</p></div>
            <label className="switch-label"><input type="checkbox" role="switch" disabled={draft.mode === 'tailscale'} checked={draft.proxyEnabled} onChange={(event) => update('proxyEnabled', event.target.checked)} aria-label="Use SOCKS5 proxy" /><span className="switch-track" /><span className="switch-caption">{draft.proxyEnabled ? 'On' : 'Off'}</span></label>
          </div>
          {draft.proxyEnabled && <div className="proxy-fields">
            <div className="proxy-address-fields">
              <label className="field-label">Proxy host<input className="text-input" value={draft.proxyHost} onChange={(event) => update('proxyHost', event.target.value)} placeholder="proxy.example.com" autoComplete="off" spellCheck={false} required /></label>
              <label className="field-label">Port<input className="text-input" type="number" min={1} max={65535} value={draft.proxyPort || ''} onChange={(event) => update('proxyPort', Number(event.target.value))} placeholder="1080" required /></label>
            </div>
            <div className="settings-fields">
              <label className="field-label">Username <span className="optional">Optional</span><input className="text-input" value={draft.proxyUsername} onChange={(event) => update('proxyUsername', event.target.value)} autoComplete="off" placeholder="Username" spellCheck={false} /></label>
              <div>
                <label className="field-label">Password <span className="optional">Optional</span><input className="text-input" type="password" value={draft.proxyPassword} onChange={(event) => update('proxyPassword', event.target.value)} autoComplete="new-password" placeholder={draft.proxyPasswordSaved ? 'Saved · enter to replace' : 'Password'} /></label>
                {(draft.proxyPasswordSaved || draft.proxyPassword) && <button className="text-button clear-secret" type="button" onClick={() => setDraft((previous) => ({ ...previous, proxyPassword: '', proxyPasswordSaved: false }))}><X size={12} />Clear password</button>}
              </div>
            </div>
            <p className="settings-note"><ShieldCheck size={14} />Connections stop if the proxy is unavailable. Changing its host, port, or username clears the saved password.</p>
          </div>}
          {!draft.proxyEnabled && (draft.proxyPasswordSaved || draft.proxyPassword) && <button className="text-button clear-secret" type="button" onClick={() => setDraft((previous) => ({ ...previous, proxyUsername: '', proxyPassword: '', proxyPasswordSaved: false }))}><X size={12} />Clear saved proxy credentials</button>}
        </section>
        {error && <div className="inline-error" role="alert"><Info size={16} />{error}</div>}
        <div className="settings-actions"><span>Save to apply your changes.</span><button className="button" type="button" onClick={() => { setDraft({ ...network }); setError(''); }}>Reset changes</button><button className="button primary" type="submit">{busy ? <Spinner /> : <Check size={15} />}Save settings</button></div>
      </fieldset>
    </form>
  </>;
}
