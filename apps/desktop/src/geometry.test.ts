import assert from 'node:assert/strict';
import test from 'node:test';
import { displayPoint } from './geometry';

const display = { id: 1, name: 'Remote monitor', width: 1920, height: 1080, x: -1920, y: 0 };

test('letterboxed pointer is mapped into native display-relative pixels', () => {
  const box = { left: 100, top: 50, width: 1000, height: 800 };
  assert.deepEqual(displayPoint(600, 450, box, display), { x: 960, y: 540, inside: true });
  // Top letterbox is not an interactive part of the remote desktop.
  assert.equal(displayPoint(600, 60, box, display)?.inside, false);
  // The native desktop offset must not be added by the renderer.
  assert.equal(displayPoint(100, 450, box, display)?.x, 0);
});

test('pillarboxed pointer uses the visible image width and clamps captured drags', () => {
  const portrait = { ...display, width: 1080, height: 1920 };
  const box = { left: 10, top: 20, width: 1200, height: 600 };
  assert.deepEqual(displayPoint(610, 320, box, portrait), { x: 540, y: 960, inside: true });
  assert.deepEqual(displayPoint(1210, 620, box, portrait), { x: 1079, y: 1919, inside: false });
});

test('a hidden or zero-size screen produces no pointer event', () => {
  assert.equal(displayPoint(0, 0, { left: 0, top: 0, width: 0, height: 0 }, display), null);
});
