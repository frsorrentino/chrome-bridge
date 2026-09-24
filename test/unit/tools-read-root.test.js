/**
 * upload_file legge un file del disco e lo mette in un form della pagina: una
 * pagina ostile con prompt injection può chiedere una chiave o un .env.
 *
 * - Senza CHROME_BRIDGE_READ_ROOT: chiavi e credenziali rifiutate (cartelle
 *   come ~/.ssh, nomi come .env, id_ed25519, *.pem), il resto passa.
 * - Con CHROME_BRIDGE_READ_ROOT: passa solo quello che sta sotto la radice,
 *   qualunque nome abbia.
 * Il rifiuto arriva prima del comando all'estensione e segue i symlink.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTools } from '../../server/tools.js';

function build(options = {}) {
  const handlers = new Map(); const sent = [];
  registerTools(
    { tool: (n, _d, s, ...rest) => handlers.set(n, { handler: rest[rest.length - 1], schema: s }) },
    { isConnected: () => true, mode: 'primary', host: 'h', port: 1, sendCommand: async (t, p) => { sent.push({ type: t, params: p }); return { ok: true }; } },
    'all',
    options,
  );
  return { handlers, sent };
}
const textOf = (res) => res.content.map((c) => c.text ?? '').join('\n');

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'cb-read-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('upload_file senza radice: chiavi e credenziali rifiutate prima dell\'estensione', async () => {
  await withDir(async (dir) => {
    const { handlers, sent } = build();
    for (const name of ['.env', '.env.production', 'id_ed25519', 'id_rsa', 'server.pem', 'tls.key', 'cert.p12', '.npmrc', '.git-credentials']) {
      const file = join(dir, name);
      await writeFile(file, 'segreto');
      await assert.rejects(handlers.get('upload_file').handler({ selector: 'input', path: file }), /key or credential file/, name);
    }
    assert.equal(sent.length, 0);
  });
});

test('upload_file senza radice: un file qualunque passa', async () => {
  await withDir(async (dir) => {
    const { handlers, sent } = build();
    const file = join(dir, 'foto.png');
    await writeFile(file, 'png');
    await handlers.get('upload_file').handler({ selector: 'input', path: file });
    assert.equal(sent.length, 1);
  });
});

test('upload_file: un symlink dal nome innocuo verso una chiave è rifiutato', async () => {
  await withDir(async (dir) => {
    const { handlers, sent } = build();
    await writeFile(join(dir, 'id_ed25519'), 'chiave');
    await symlink(join(dir, 'id_ed25519'), join(dir, 'foto.png'));
    await assert.rejects(handlers.get('upload_file').handler({ selector: 'input', path: join(dir, 'foto.png') }), /key or credential file/);
    assert.equal(sent.length, 0);
  });
});

test('upload_file: le cartelle delle credenziali sono rifiutate per posizione, non per nome', async () => {
  const { handlers } = build();
  // Il percorso non serve che esista: basta che realpath lo risolva. ~/.ssh
  // di solito c'è; se manca il test verifica solo che non passi.
  const target = join(homedir(), '.ssh', 'known_hosts');
  await assert.rejects(handlers.get('upload_file').handler({ selector: 'input', path: target }), /key or credential file|ENOENT/);
});

test('upload_file con radice: passa solo quello che sta sotto, anche una chiave', async () => {
  await withDir(async (root) => {
    await withDir(async (outside) => {
      const { handlers, sent } = build({ readRoot: root });
      await writeFile(join(root, 'tls.key'), 'chiave del certificato');
      await handlers.get('upload_file').handler({ selector: 'input', path: join(root, 'tls.key') });
      assert.equal(sent.length, 1);

      await writeFile(join(outside, 'foto.png'), 'png');
      await assert.rejects(handlers.get('upload_file').handler({ selector: 'input', path: join(outside, 'foto.png') }), /CHROME_BRIDGE_READ_ROOT/);
      await assert.rejects(handlers.get('upload_file').handler({ selector: 'input', path: join(root, '..', outside.split('/').pop(), 'foto.png') }), /CHROME_BRIDGE_READ_ROOT/);
      assert.equal(sent.length, 1);
    });
  });
});

test('readRoot si vede in get_status', async () => {
  await withDir(async (root) => {
    assert.equal(JSON.parse(textOf(await build({ readRoot: root }).handlers.get('get_status').handler({}))).read_root, root);
    assert.equal(JSON.parse(textOf(await build().handlers.get('get_status').handler({}))).read_root, null);
  });
});
