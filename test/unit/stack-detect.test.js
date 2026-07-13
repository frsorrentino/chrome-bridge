import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../extension/stack-detect.js';

const { detectStack } = globalThis.__cbStackDetect;

// Doc finto: querySelector su meta generator, querySelectorAll su lista script src
function fakeDoc({ metaGenerator = null, scriptSrcs = [] } = {}) {
  return {
    querySelector: (sel) => {
      if (sel === 'meta[name="generator"]' && metaGenerator) return { content: metaGenerator };
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel === 'script[src]') return scriptSrcs.map((src) => ({ src }));
      return [];
    },
  };
}

test('rileva React da hook devtools', () => {
  const win = { __REACT_DEVTOOLS_GLOBAL_HOOK__: {} };
  assert.ok(detectStack(win, fakeDoc()).includes('React'));
});

test('rileva Vue, jQuery con versione', () => {
  const win = { Vue: { version: '3.4.0' }, jQuery: { fn: { jquery: '3.7.1' } } };
  const out = detectStack(win, fakeDoc());
  assert.ok(out.includes('Vue'));
  assert.ok(out.includes('jQuery'));
});

test('rileva WordPress da meta generator', () => {
  const out = detectStack({}, fakeDoc({ metaGenerator: 'WordPress 6.5' }));
  assert.ok(out.includes('WordPress'));
});

test('rileva Vite da script src', () => {
  const out = detectStack({}, fakeDoc({ scriptSrcs: ['/@vite/client', '/src/main.js'] }));
  assert.ok(out.includes('Vite'));
});

test('pagina anonima → array vuoto', () => {
  assert.deepEqual(detectStack({}, fakeDoc()), []);
});
