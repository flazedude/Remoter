import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from './api';

export function useSharing(deviceId: string, closing: boolean) {
  const [sound, setSound] = useState(false);
  const [clipboard, setClipboard] = useState(false);
  const [error, setError] = useState('');
  const audioContext = useRef<AudioContext | null>(null);
  const startingSound = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; void audioContext.current?.close().catch(() => {}); }; }, []);
  useEffect(() => { if (closing) { setSound(false); setClipboard(false); } }, [closing]);

  async function toggleSound() {
    setError('');
    if (sound) { setSound(false); return; }
    if (startingSound.current) return;
    startingSound.current = true;
    try {
      const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      audioContext.current = context;
      await context.resume();
      if (mounted.current) setSound(true); else await context.close();
    } catch (error) { void audioContext.current?.close().catch(() => {}); audioContext.current = null; if (mounted.current) setError(errorMessage(error)); }
    finally { startingSound.current = false; }
  }

  useEffect(() => {
    if (!sound || closing) return;
    const currentContext = audioContext.current;
    if (!currentContext) { setSound(false); return; }
    const context: AudioContext = currentContext;
    let active = true;
    let sequence = 0;
    let nextTime = 0;
    const sources = new Set<AudioBufferSourceNode>();
    async function play() {
      try {
        while (active) {
          const packet = await api.audio({ deviceId, after: sequence });
          if (!active) return;
          if (!packet.data) continue;
          const bytes = Uint8Array.from(atob(packet.data), char => char.charCodeAt(0));
          const samples = new DataView(bytes.buffer);
          const frames = bytes.length / 4;
          const buffer = context.createBuffer(2, frames, packet.sampleRate);
          for (let channel = 0; channel < 2; channel++) {
            const output = buffer.getChannelData(channel);
            for (let frame = 0; frame < frames; frame++) output[frame] = samples.getInt16((frame * 2 + channel) * 2, true) / 32768;
          }
          if (packet.sequence !== sequence + 1 || nextTime < context.currentTime || nextTime > context.currentTime + 0.3) {
            for (const source of sources) source.stop();
            sources.clear(); nextTime = context.currentTime + 0.1;
          }
          sequence = packet.sequence;
          const source = context.createBufferSource();
          source.buffer = buffer; source.connect(context.destination);
          sources.add(source);
          source.onended = () => { sources.delete(source); source.disconnect(); };
          source.start(nextTime); nextTime += buffer.duration;
        }
      } catch (error) { if (active) { setError(`Sound: ${errorMessage(error)}`); setSound(false); } }
    }
    void play();
    return () => { active = false; void context.close().catch(() => {}); if (audioContext.current === context) audioContext.current = null; };
  }, [sound, closing, deviceId]);

  const transferClipboard = useCallback(async (direction: 'send' | 'receive' | 'paste') => {
    try { await api.clipboardSync({ deviceId, direction }); setError(''); }
    catch (error) { setError(`Clipboard: ${errorMessage(error)}`); throw error; }
  }, [deviceId]);

  useEffect(() => {
    if (!clipboard || closing) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { await api.clipboardSync({ deviceId, direction: 'both' }); }
      catch (error) { if (active) { setError(`Clipboard: ${errorMessage(error)}`); setClipboard(false); } return; }
      if (active) timer = setTimeout(() => void poll(), 600);
    }
    void api.clipboardSync({ deviceId, direction: 'reset' }).then(() => { if (active) void poll(); }).catch(error => { if (active) { setError(errorMessage(error)); setClipboard(false); } });
    return () => { active = false; clearTimeout(timer); };
  }, [clipboard, closing, deviceId]);

  return { sound, toggleSound, clipboard, toggleClipboard: () => { setError(''); setClipboard(!clipboard); }, transferClipboard, error };
}
