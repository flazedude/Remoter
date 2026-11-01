import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowLeft, ChevronDown, Clipboard, Copy, Info, Keyboard, LoaderCircle, Maximize2, Monitor, MousePointer2, Pause, Play, ShieldCheck, Volume2, VolumeX, ClipboardPaste } from 'lucide-react';
import { api, errorMessage } from './api';
import { displayPoint } from './geometry';
import { defaultQuality, nextFrameAt, qualityProfiles, StreamResolution } from './stream-settings';
import { useSharing } from './use-sharing';
import type { Device, HostInfo, NetworkSettings, RemoteInput } from './types';

interface SessionProps {
  device: Device;
  info: HostInfo;
  network: NetworkSettings;
  disconnecting: boolean;
  onDisconnect: () => Promise<void>;
}

export default function Session({ device, info, network, disconnecting, onDisconnect }: SessionProps) {
  const [displayId, setDisplayId] = useState(info.displays[0].id);
  const [quality, setQuality] = useState<keyof typeof qualityProfiles>(() => defaultQuality(device.endpoint, network));
  const [fps, setFps] = useState(0);
  const [streamWidth, setStreamWidth] = useState(0);
  const [frame, setFrame] = useState('');
  const [frameError, setFrameError] = useState('');
  const [inputError, setInputError] = useState('');
  const [control, setControl] = useState(false);
  const [focused, setFocused] = useState(false);
  const [paused, setPaused] = useState(false);
  const [received, setReceived] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [closing, setClosing] = useState(false);
  const sharing = useSharing(device.id, closing || disconnecting);
  const closingRef = useRef(false);
  const screen = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const controlRef = useRef(false);
  const autoControlPending = useRef(info.capabilities.input);
  const inputQueue = useRef(Promise.resolve());
  const queuedInputs = useRef(0);
  const inputGeneration = useRef(0);
  const moveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingMove = useRef<RemoteInput | null>(null);
  const moveSending = useRef(false);
  const config = useRef({ displayId, quality, paused });
  config.current = { displayId, quality, paused: paused || closing };
  const display = info.displays.find((candidate) => candidate.id === displayId)!;
  const displayRef = useRef(display);
  displayRef.current = display;

  const send = useCallback((event: RemoteInput) => {
    // Preserve button/key ordering even if requests finish at different times.
    if (event.type !== 'releaseAll' && queuedInputs.current >= 32) {
      inputGeneration.current++;
      controlRef.current = false;
      setControl(false);
      setInputError('Input paused because this connection is too slow. Try again when it recovers.');
      inputQueue.current = inputQueue.current.then(() => api.input({ deviceId: device.id, event: { type: 'releaseAll' } })).catch(() => undefined);
      return inputQueue.current;
    }
    const generation = inputGeneration.current;
    queuedInputs.current++;
    inputQueue.current = inputQueue.current.then(async () => {
      if (event.type !== 'releaseAll' && (generation !== inputGeneration.current || !controlRef.current)) return;
      await api.input({ deviceId: device.id, event });
    }).catch(async (error) => {
      if (event.type !== 'releaseAll') {
        inputGeneration.current++;
        controlRef.current = false;
        setControl(false);
        setInputError(errorMessage(error));
        await api.input({ deviceId: device.id, event: { type: 'releaseAll' } }).catch(() => undefined);
      }
    }).finally(() => { queuedInputs.current--; });
    return inputQueue.current;
  }, [device.id]);

  const release = useCallback(() => {
    inputGeneration.current++;
    clearTimeout(moveTimer.current);
    moveTimer.current = undefined;
    pendingMove.current = null;
    return send({ type: 'releaseAll' });
  }, [send]);

  const stopControl = useCallback(() => {
    autoControlPending.current = false;
    controlRef.current = false;
    setControl(false);
    void release();
  }, [release]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sampleStart = performance.now();
    let sampleFrames = 0;
    let resolution = new StreamResolution();
    let previousQuality = config.current.quality;
    let nextAt = performance.now();
    async function poll() {
      if (!active) return;
      if (config.current.paused) { sampleStart = performance.now(); nextAt = sampleStart; sampleFrames = 0; setFps(0); timer = setTimeout(() => void poll(), 200); return; }
      const request = config.current;
      const started = performance.now();
      let delay = 1;
      try {
        const selectedDisplay = info.displays.find((item) => item.id === request.displayId)!;
        const profile = qualityProfiles[request.quality];
        if (request.quality !== previousQuality) { resolution = new StreamResolution(); previousQuality = request.quality; }
        const width = Math.max(320, Math.min(request.quality === 'lan' ? resolution.width : profile.width, selectedDisplay.width));
        const next = await api.frame({ deviceId: device.id, displayId: request.displayId, quality: profile.quality, width });
        if (active && request.displayId === config.current.displayId && !config.current.paused) {
          setFrame(next); setFrameError(''); setReceived(true);
          setStreamWidth(Math.min(width, selectedDisplay.width));
          if (request.quality === 'lan') resolution.sample(performance.now() - started);
          sampleFrames++;
          const elapsed = performance.now() - sampleStart;
          if (elapsed >= 1000) { setFps(Math.round(sampleFrames * 1000 / elapsed)); sampleStart = performance.now(); sampleFrames = 0; }
        }
        nextAt = nextFrameAt(nextAt, profile.fps, performance.now());
        delay = Math.max(0, nextAt - performance.now());
      } catch (error) {
        if (active) { setFrameError(errorMessage(error)); stopControl(); }
        delay = 1500;
        setFps(0); sampleStart = performance.now(); nextAt = sampleStart + delay; sampleFrames = 0;
      }
      // Exactly one outstanding frame request; slow capture supplies backpressure.
      if (active) {
        if (delay > 0) timer = setTimeout(() => void poll(), delay);
        else void poll(); // The completed IPC request already yielded the event loop.
      }
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [device.id, info.displays, stopControl]);

  useEffect(() => {
    const onBlur = () => { setFocused(false); void release(); };
    const onHidden = () => { if (document.hidden) onBlur(); };
    const onFullscreen = () => setFullscreen(!!document.fullscreenElement);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onHidden);
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => {
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onHidden);
      document.removeEventListener('fullscreenchange', onFullscreen);
      controlRef.current = false;
      void release();
    };
  }, [release]);

  useEffect(() => {
    const element = screen.current;
    if (!element) return;
    function wheel(event: WheelEvent) {
      if (!controlRef.current || document.activeElement !== element) return;
      event.preventDefault();
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? element!.clientHeight : 1;
      const clamp = (value: number) => Math.max(-1200, Math.min(1200, Math.round(value)));
      void send({ type: 'scroll', deltaX: clamp(event.deltaX * scale), deltaY: clamp(event.deltaY * scale) });
    }
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [send]);

  function point(event: ReactPointerEvent<HTMLDivElement>) {
    if (!screen.current) return null;
    return displayPoint(event.clientX, event.clientY, screen.current.getBoundingClientRect(), displayRef.current);
  }

  function queueMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!controlRef.current || document.activeElement !== screen.current) return;
    const position = point(event);
    if (!position || (!position.inside && event.buttons === 0)) return;
    pendingMove.current = { type: 'move', displayId, x: position.x, y: position.y };
    async function flushMove() {
      moveTimer.current = undefined;
      if (!pendingMove.current || !controlRef.current) return;
      moveSending.current = true;
      const next = pendingMove.current;
      pendingMove.current = null;
      await send(next);
      moveSending.current = false;
      if (pendingMove.current && controlRef.current) moveTimer.current = setTimeout(() => void flushMove(), 16);
    }
    if (!moveTimer.current && !moveSending.current) moveTimer.current = setTimeout(() => void flushMove(), 16);
  }

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    screen.current?.focus();
    if (!controlRef.current) return;
    const position = point(event);
    if (!position?.inside || event.button > 2) return;
    event.preventDefault();
    clearTimeout(moveTimer.current); moveTimer.current = undefined; pendingMove.current = null;
    event.currentTarget.setPointerCapture(event.pointerId);
    void send({ type: 'move', displayId, x: position.x, y: position.y });
    void send({ type: 'button', button: (['left', 'middle', 'right'] as const)[event.button], down: true });
  }

  function pointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (!controlRef.current || event.button > 2) return;
    event.preventDefault();
    clearTimeout(moveTimer.current); moveTimer.current = undefined; pendingMove.current = null;
    const position = point(event);
    if (position) void send({ type: 'move', displayId, x: position.x, y: position.y });
    void send({ type: 'button', button: (['left', 'middle', 'right'] as const)[event.button], down: false });
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function toggleControl() {
    setInputError('');
    if (control) stopControl();
    else { controlRef.current = true; setControl(true); screen.current?.focus(); }
  }

  async function disconnect() {
    if (closingRef.current) return;
    closingRef.current = true;
    config.current.paused = true;
    setClosing(true);
    stopControl();
    try {
      await inputQueue.current;
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
      await onDisconnect();
    } catch (error) {
      setInputError(errorMessage(error));
      closingRef.current = false;
      setClosing(false);
    }
  }

  return <div className="session-layout" ref={container}>
    <div className="session-toolbar"><button className="icon-button session-back" onClick={() => void disconnect()} disabled={disconnecting || closing} aria-label="Disconnect and return to devices" title="Disconnect">{disconnecting || closing ? <LoaderCircle className="spin" size={18} /> : <ArrowLeft size={19} />}</button><div className="session-identity"><strong>{device.name}</strong><span>{info.os} · {display.width} × {display.height}</span></div><div className="session-tools">
      <label className="compact-select"><Monitor size={15} /><span className="sr-only">Display</span><select disabled={closing} value={displayId} onChange={(event) => { stopControl(); setFrame(''); setReceived(false); setDisplayId(Number(event.target.value)); }}>{info.displays.map((item, index) => <option key={item.id} value={item.id}>{item.name || `Display ${index + 1}`}</option>)}</select><ChevronDown size={12} /></label>
      <label className="compact-select quality-select"><span className="sr-only">Picture quality</span><select disabled={closing} value={quality} onChange={(event) => setQuality(event.target.value as keyof typeof qualityProfiles)}><option value="lan">LAN · Smooth</option><option value="original">Original · Max quality</option><option value="balanced">Balanced</option><option value="sharp">Sharper image</option><option value="fast">Less bandwidth</option></select><ChevronDown size={12} /></label>
      <span className="toolbar-divider" />
      <button className={`icon-button${sharing.sound ? ' sharing-active' : ''}`} disabled={closing || !info.capabilities.audio} aria-label={sharing.sound ? 'Mute host sound' : 'Hear host sound'} aria-pressed={sharing.sound} title={info.capabilities.audio ? 'Hear system audio from this host' : 'Enable system audio on the host before sharing'} onClick={() => void sharing.toggleSound()}>{sharing.sound ? <Volume2 size={17} /> : <VolumeX size={17} />}</button>
      <button className={`icon-button${sharing.clipboard ? ' sharing-active' : ''}`} disabled={closing || !info.capabilities.clipboard} aria-label="Sync text clipboard" aria-pressed={sharing.clipboard} title={info.capabilities.clipboard ? 'Automatically sync copied text in both directions' : 'Enable two-way text clipboard on the host before sharing'} onClick={sharing.toggleClipboard}><Clipboard size={17} /></button>
      <button className={`button small control-button${control ? ' primary' : ''}`} disabled={closing || !info.capabilities.input || !received || !!frameError || paused} title={info.capabilities.input ? 'Press Escape to release control' : 'Keyboard and mouse control are disabled on this host'} aria-pressed={control} onPointerDown={(event) => event.preventDefault()} onClick={toggleControl}>{control ? <MousePointer2 size={15} /> : <ShieldCheck size={15} />}{control ? 'Controlling' : 'View only'}</button>
      <button className="icon-button" title={paused ? 'Resume screen updates' : 'Pause screen updates'} aria-label={paused ? 'Resume screen updates' : 'Pause screen updates'} aria-pressed={paused} disabled={closing} onClick={() => { stopControl(); setPaused(!paused); }}>{paused ? <Play size={16} /> : <Pause size={16} />}</button>
      <button className="icon-button" title={fullscreen ? 'Exit full screen' : 'Full screen'} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'} disabled={closing} onClick={() => { stopControl(); const action = document.fullscreenElement ? document.exitFullscreen() : container.current?.requestFullscreen(); action?.catch((error) => setInputError(errorMessage(error))); }}><Maximize2 size={16} /></button>
    </div></div>

    {info.synthetic && <div className="preview-banner"><Info size={14} />Synthetic test display · No physical desktop is being captured.</div>}
    {info.warning && <div className="session-error" role="status"><Info size={15} />{info.warning}</div>}
    {inputError && <div className="session-error" role="alert"><Info size={15} />Control stopped: {inputError}</div>}
    {sharing.error && <div className="session-error" role="alert"><Info size={15} />{sharing.error}</div>}
    {sharing.clipboard && <div className="clipboard-tools"><span><Clipboard size={14} />Text clipboard sync on</span><button className="button small" disabled={closing} onClick={() => void sharing.transferClipboard('send').catch(() => {})}><ClipboardPaste size={14} />Send clipboard to host</button><button className="button small" disabled={closing} onClick={() => void sharing.transferClipboard('receive').catch(() => {})}><Copy size={14} />Get host clipboard</button></div>}

    <div className={`remote-screen${control ? ' controlling' : ''}${focused ? ' screen-focused' : ''}`} ref={screen} tabIndex={0} role={control ? 'application' : 'region'} aria-label={`${device.name} remote desktop. ${control ? 'Keyboard and mouse control enabled. Press Escape to release control.' : 'View only.'}`}
      onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); void release(); }}
      onPointerMove={queueMove} onPointerDown={pointerDown} onPointerUp={pointerUp} onPointerCancel={() => void release()}
      onContextMenu={(event) => { if (controlRef.current) event.preventDefault(); }}
      onKeyDown={(event) => {
        if (!controlRef.current) return;
        event.preventDefault(); event.stopPropagation();
        if (event.code === 'Escape') { stopControl(); return; }
        if (sharing.clipboard && event.code === 'KeyV' && (event.ctrlKey || event.metaKey) && !event.repeat) {
          // Reconcile both sides before paste. An unconditional send can replace
          // a fresh remote copy with stale local text before the next sync poll.
          inputQueue.current = inputQueue.current.then(() => sharing.transferClipboard('paste')).catch(() => { stopControl(); });
        }
        if (event.code) void send({ type: 'key', code: event.code, down: true });
      }}
      onKeyUp={(event) => { if (!controlRef.current) return; event.preventDefault(); event.stopPropagation(); if (event.code) void send({ type: 'key', code: event.code, down: false }); }}>
      {frame && <img className="desktop-frame" src={frame} alt={`Remote display of ${device.name}`} draggable={false} onLoad={() => {
        if (autoControlPending.current && !closingRef.current && !config.current.paused) {
          autoControlPending.current = false;
          controlRef.current = true; setControl(true);
          if (!document.hidden) screen.current?.focus();
        }
      }} />}
      {!frame && !frameError && <div className="session-placeholder"><LoaderCircle className="spin" size={25} /><span>Waiting for the first frame…</span></div>}
      {frameError && <div className="capture-error"><Info size={24} /><strong>Waiting for the host</strong><p>{frameError}</p><span>Reconnecting automatically…</span></div>}
      {paused && <div className="paused-indicator"><Pause size={14} />Screen updates paused</div>}
    </div>
    <div className="session-footer"><span><span className={`session-status-dot${frameError ? ' interrupted' : received ? ' live' : ''}`} />{closing ? 'Disconnecting' : paused ? 'Paused' : frameError ? 'Connection interrupted' : received ? 'Screen sharing' : 'Connecting'}</span><span>{control ? <><Keyboard size={13} />Press Esc to release control</> : info.capabilities.input ? 'Select “View only” to enable control' : 'The host allows viewing only'}</span><span className="capture-cadence" title="Received frame rate; capture speed and connection determine actual FPS">{fps} FPS · Target {qualityProfiles[quality].fps}{streamWidth ? ` · ${streamWidth}px` : ''}{quality === 'lan' ? ' · LAN' : ''}</span></div>
  </div>;
}
