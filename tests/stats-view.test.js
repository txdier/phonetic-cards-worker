import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { createStatsView, formatActiveTime } from '../public/stats-view.js';

test('active reading time is formatted without noisy zero units', () => {
  assert.equal(formatActiveTime(0), '0秒');
  assert.equal(formatActiveTime(3_661_000), '1小时 1分 1秒');
  assert.equal(formatActiveTime(120_000), '2分');
});

test('statistics render every required per-article metric without a grand total', async () => {
  const dom = new JSDOM('<main id="root"></main>');
  const previousDocument = globalThis.document;
  globalThis.document = dom.window.document;
  const root = document.getElementById('root');
  const cleanup = createStatsView({
    root,
    api: async path => {
      assert.equal(path, '/api/article-stats');
      return [{
        id: 'a1', title: '<script>Unsafe</script>', read_count: 3,
        active_read_ms: 61_000, marking_count: 7, pending_marking_count: 4,
        converted_marking_count: 3, full_read_aloud_count: 2
      }];
    }
  });
  try {
    await new Promise(resolve => setImmediate(resolve));
    const card = root.querySelector('[data-article-id="a1"]');
    assert.ok(card);
    assert.equal(root.querySelector('script'), null);
    assert.match(card.textContent, /完整阅读\s*3次/);
    assert.match(card.textContent, /有效时长\s*1分 1秒/);
    assert.match(card.textContent, /显式标记\s*7/);
    assert.match(card.textContent, /待处理\s*4/);
    assert.match(card.textContent, /已转入词本\s*3/);
    assert.match(card.textContent, /完整朗读\s*2次/);
    assert.equal(root.querySelector('[data-role="stats-total"]'), null);
  } finally {
    cleanup();
    dom.window.close();
    globalThis.document = previousDocument;
  }
});

test('statistics load failure is a persistent inline alert', async () => {
  const dom = new JSDOM('<main id="root"></main>');
  const previousDocument = globalThis.document;
  globalThis.document = dom.window.document;
  const root = document.getElementById('root');
  const cleanup = createStatsView({ root, api: async () => { throw new Error('统计断线'); } });
  try {
    await new Promise(resolve => setImmediate(resolve));
    const error = root.querySelector('.pc-inline-error');
    assert.ok(error);
    assert.equal(error.getAttribute('role'), 'alert');
    assert.equal(error.textContent, '统计断线');
  } finally {
    cleanup();
    dom.window.close();
    globalThis.document = previousDocument;
  }
});
