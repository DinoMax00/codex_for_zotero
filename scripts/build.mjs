import { build } from 'esbuild';
import { mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
const addon = path.join(dist, 'addon');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(root, 'addon/manifest.json'), 'utf8'));
if (pkg.version !== manifest.version) throw new Error('Package and add-on versions differ');
await rm(addon, { recursive: true, force: true });
await mkdir(addon, { recursive: true });
// Explicit inputs keep screenshots, local records and old builds out of releases.
for (const name of ['bootstrap.js', 'manifest.json', 'content', 'locale']) {
  await cp(path.join(root, 'addon', name), path.join(addon, name), { recursive: true });
}
for (const name of ['server.mjs', 'rpc.mjs', 'store.mjs', 'service.mjs', 'media.mjs']) {
  await mkdir(path.join(addon, 'bridge'), { recursive: true });
  await cp(path.join(root, 'bridge', name), path.join(addon, 'bridge', name));
}
await cp(path.join(root, 'LICENSE'), path.join(addon, 'LICENSE'));
await mkdir(path.join(addon, 'third-party'), { recursive: true });
for (const [source, target] of [
  ['dompurify/LICENSE', 'DOMPurify-LICENSE'],
  ['marked/LICENSE.md', 'marked-LICENSE.md'],
  ['katex/LICENSE', 'KaTeX-LICENSE'],
]) {
  await cp(path.join(root, 'node_modules', source), path.join(addon, 'third-party', target));
}
await build({
  entryPoints: [path.join(root, 'src/plugin.js')],
  bundle: true,
  format: 'iife',
  globalName: 'CFZ',
  target: 'firefox140',
  outfile: path.join(addon, 'content/plugin.js'),
  loader: { '.css': 'text' },
  legalComments: 'eof',
  sourcemap: false,
});
function zip(output, sources) {
  const result = spawnSync(
    'python3',
    [
      '-c',
      `
import pathlib,sys,zipfile
root=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED) as z:
 for source in sys.argv[3:]:
  p=root/source
  for f in sorted(p.rglob('*')) if p.is_dir() else [p]:
   if not f.is_file() or '__pycache__' in f.parts or f.suffix=='.pyc' or f.name=='.DS_Store': continue
   info=zipfile.ZipInfo(f.relative_to(root).as_posix(),(2020,1,1,0,0,0))
   info.compress_type=zipfile.ZIP_DEFLATED
   info.external_attr=0o100644 << 16
   z.writestr(info,f.read_bytes())
`,
      sources.root,
      output,
      ...sources.paths,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(result.stderr || 'ZIP packaging failed');
}
const xpiName = `codex-for-zotero-${pkg.version}.xpi`;
const skillsName = `codex-for-zotero-skills-${pkg.version}.zip`;
zip(path.join(dist, xpiName), { root: addon, paths: ['.'] });
zip(path.join(dist, skillsName), { root, paths: ['skills', 'LICENSE'] });
const sha256 = async (name) =>
  createHash('sha256')
    .update(await readFile(path.join(dist, name)))
    .digest('hex');
const updates = {
  addons: {
    [manifest.applications.zotero.id]: {
      updates: [
        {
          version: pkg.version,
          update_link: `${pkg.homepage.split('#')[0]}/releases/download/v${pkg.version}/${xpiName}`,
          update_hash: `sha256:${await sha256(xpiName)}`,
          applications: {
            zotero: {
              strict_min_version: manifest.applications.zotero.strict_min_version,
              strict_max_version: manifest.applications.zotero.strict_max_version,
            },
          },
        },
      ],
    },
  },
};
await writeFile(path.join(dist, 'updates.json'), JSON.stringify(updates, null, 2) + '\n');
await writeFile(
  path.join(dist, 'SHA256SUMS'),
  (
    await Promise.all(
      [xpiName, skillsName, 'updates.json'].map(async (name) => `${await sha256(name)}  ${name}\n`),
    )
  ).join(''),
);
console.log(`Built ${xpiName}, ${skillsName}, updates.json and SHA256SUMS`);
