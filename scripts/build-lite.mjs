// Builds Snap Lite (lite/main.js) into one self-contained script:
//   dist/snap-lite.js                  paste into a UI Script named snap_lite (see README)
//   dist/snap-lite-command.js          the whole app as one SN Utils script command, for trying it
//                                      without a UI Script; written only when SN Utils' variable
//                                      substitution ($0, $table…) can't corrupt the bundle
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
const out = new URL('../dist/', import.meta.url);
await mkdir(out, { recursive: true });

const result = await build({
  entryPoints: [new URL('../lite/main.js', import.meta.url).pathname],
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  minify: true,
  legalComments: 'none',
  loader: { '.css': 'text' },
  define: { __VERSION__: JSON.stringify(pkg.version) },
  write: false,
  metafile: true,
});
let code = result.outputFiles[0].text.replace('__VERSION__', pkg.version);
const banner = `/* Snap Lite ${pkg.version} — built ${new Date().toISOString()} */\n`;
await writeFile(new URL('snap-lite.js', out), banner + code);
console.log(`dist/snap-lite.js  ${(code.length / 1024).toFixed(1)} KB`);

// SN Utils replaces $0, $1…, $date, $sysid, $table, $TableName, $encodedquery and $ext/ anywhere in
// a command's text. The loader command only uses them on purpose; the bundle mustn't contain any.
const SNU_VARS = /\$(?:\d|date\b|sysid\b|table\b|TableName\b|encodedquery\b|ext\/)/;
const clash = SNU_VARS.exec(code);
if (clash) {
  console.warn(`dist/snap-lite-command.js not written: the bundle contains "${clash[0]}", which SN Utils would substitute. Use the UI Script + loader instead.`);
} else {
  const loader = await readFile(new URL('../snutils/snap-lite-command.js', import.meta.url), 'utf8');
  // Same command, but define SnapLite from an embedded copy instead of fetching the UI Script. It is
  // run with the top window's Function so it lands there even when the command runs in gsft_main.
  const marker = '  if (win.SnapLite) return win.SnapLite.run(record);';
  if (!loader.includes(marker)) throw new Error('snap-lite-command.js changed: update the inline build');
  const inline = loader.replace(marker, `  if (!win.SnapLite) win.Function(${JSON.stringify(code)})();\n${marker}`);
  await writeFile(new URL('snap-lite-command.js', out), banner + inline);
  console.log(`dist/snap-lite-command.js  ${(inline.length / 1024).toFixed(1)} KB`);
}
