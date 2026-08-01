import test from 'node:test';
import assert from 'node:assert/strict';

import { anchoredPanelPosition } from '../public/lib/floating-panel.js';

test('anchored panel stays inside the desktop viewport near the bottom-right corner', () => {
  assert.deepEqual(anchoredPanelPosition({
    anchorRect: { left: 1100, top: 700, bottom: 744 },
    panelRect: { width: 312, height: 366 },
    viewportWidth: 1366,
    viewportHeight: 768
  }), { left: 1042, top: 326 });
});

test('anchored panel keeps its preferred gap when space is available', () => {
  assert.deepEqual(anchoredPanelPosition({
    anchorRect: { left: 240, bottom: 100 },
    panelRect: { width: 288, height: 260 },
    viewportWidth: 1200,
    viewportHeight: 800
  }), { left: 240, top: 108 });
});

test('anchored panel handles viewports smaller than the panel without negative coordinates', () => {
  assert.deepEqual(anchoredPanelPosition({
    anchorRect: { left: 260, bottom: 220 },
    panelRect: { width: 312, height: 366 },
    viewportWidth: 280,
    viewportHeight: 240
  }), { left: 12, top: 12 });
});
