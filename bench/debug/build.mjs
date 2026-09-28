// Builds dist/app.min.js (one line) and a line-level source map from src/cart.js,
// so the demo stack traces point at dist/app.min.js:1:<col> and resolve back
// to src/cart.js:<line>. No bundler needed for a single file.
import { readFileSync, writeFileSync } from 'node:fs';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const vlq = (n) => {
  let v = n < 0 ? (-n << 1) | 1 : n << 1, out = '';
  do { let d = v & 31; v >>>= 5; if (v) d |= 32; out += B64[d]; } while (v);
  return out;
};

const src = readFileSync(new URL('./src/cart.js', import.meta.url), 'utf8').split('\n');
let code = '', segs = [], prev = [0, 0, 0, 0];
for (let i = 0; i < src.length; i++) {
  const line = src[i];
  const t = line.trim();
  if (!t || t.startsWith('//')) continue;
  const genCol = code.length, srcCol = line.length - line.trimStart().length;
  const cur = [genCol, 0, i, srcCol];
  segs.push(cur.map((v, k) => vlq(v - prev[k])).join(''));
  prev = cur;
  code += t;
}
writeFileSync(new URL('./dist/app.min.js', import.meta.url), code + '\n//# sourceMappingURL=app.min.js.map\n');
writeFileSync(new URL('./dist/app.min.js.map', import.meta.url), JSON.stringify({
  version: 3, file: 'app.min.js', sources: ['../src/cart.js'], names: [], mappings: segs.join(','),
}));
