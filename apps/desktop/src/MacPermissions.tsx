import { useEffect, useState } from 'react';
import { api, errorMessage } from './api';
import type { HostPermissions } from './types';

export default function MacPermissions({ sharing }: { sharing: boolean }) {
  const [permissions, setPermissions] = useState<HostPermissions>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void api.getHostPermissions().then(value => { if (active) { setPermissions(value); setError(''); } })
        .catch(error => { if (active) { setPermissions(undefined); setError(errorMessage(error)); } });
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => { active = false; window.removeEventListener('focus', refresh); };
  }, []);
  async function check(permission?: 'screen' | 'input') {
    setBusy(true); setError('');
    try { setPermissions(await (permission ? api.requestHostPermission(permission) : api.getHostPermissions())); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <section className="mac-permissions" aria-label="Mac permissions">
    <h3>Mac permissions</h3>
    <p className="field-help">Screen Recording lets this Mac share its display. Accessibility is needed only for keyboard and mouse control. Connecting to another computer needs neither permission.</p>
    {(['screen', 'input'] as const).map(permission => <div className="mac-permission" key={permission}>
      <div><strong>{permission === 'screen' ? 'Screen Recording' : 'Accessibility'}</strong><span aria-live="polite">{permissions ? permissions[permission] ? 'Allowed' : 'Approval needed' : 'Not checked'}</span></div>
      <button className="button small" disabled={busy || sharing} onClick={() => void check(permission)}>Open {permission === 'screen' ? 'Screen Recording' : 'Accessibility'} settings</button>
    </div>)}
    <p className="field-help">Enable Remoter in System Settings → Privacy &amp; Security. During development, macOS may list your terminal or the remoter-host helper. After changing access, quit and reopen Remoter, then check again. Stop sharing before requesting changes.</p>
    <button className="button small" disabled={busy} onClick={() => void check()}>{busy ? 'Checking…' : 'Check permissions again'}</button>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
