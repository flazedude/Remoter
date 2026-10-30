import type { Display } from './types';

/** Map an object-fit:contain image point into display-relative native pixels. */
export function displayPoint(clientX: number, clientY: number, box: { left: number; top: number; width: number; height: number }, display: Display) {
  const scale = Math.min(box.width / display.width, box.height / display.height);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const left = box.left + (box.width - display.width * scale) / 2;
  const top = box.top + (box.height - display.height * scale) / 2;
  const x = (clientX - left) / scale;
  const y = (clientY - top) / scale;
  return {
    x: Math.max(0, Math.min(display.width - 1, Math.floor(x))),
    y: Math.max(0, Math.min(display.height - 1, Math.floor(y))),
    inside: x >= 0 && y >= 0 && x < display.width && y < display.height,
  };
}
