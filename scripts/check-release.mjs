// Publication checks operate on source/package contents, never on user state.
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(root, 'addon/manifest.json'), 'utf8'));
const files = [];
const skip = new Set(['.git', 'node_modules', 'dist', '__pycache__', '.venv', '.test-output']);
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Unexpected source symlink: ${path.relative(root, file)}`);
    if (entry.isDirectory()) await walk(file);
    else files.push(file);
  }
}
await walk(root);
const suspicious = [
  /\/(?:Users|home)\/(?!example(?:\/|\b))[^/\s"'<>]+\//,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{30,})\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:_authToken|api_key|password)\s*[=:]\s*["'][A-Za-z0-9_+\/-]{20,}["']/i,
];
function inspect(name, bytes) {
  if (
    /(?:^|\/)(?:\.env(?:\..*)?|auth\.json|connection\.json|papers\.json|bridge\.json|paper\.json|annotation-metadata\.json|\.DS_Store)$/.test(
      name,
    ) ||
    /\.(?:pdf|sqlite(?:3)?|db|log|pyc|png|jpe?g)$/i.test(name)
  ) {
    throw new Error(`Unexpected private/binary artifact: ${name}`);
  }
  const text = bytes.toString('utf8');
  if (suspicious.some((pattern) => pattern.test(text)))
    throw new Error(`Potential personal path or credential in ${name}`);
}
for (const file of files) inspect(path.relative(root, file), await readFile(file));
if (pkg.version !== manifest.version) throw new Error('Version mismatch');
for (const relative of ['bridge/rpc.mjs', 'bridge/server.mjs']) {
  if (!(await readFile(path.join(root, relative), 'utf8')).includes(`'${pkg.version}'`))
    throw new Error(`Stale client version in ${relative}`);
}
const xpi = `codex-for-zotero-${pkg.version}.xpi`;
const skills = `codex-for-zotero-skills-${pkg.version}.zip`;
const archiveScan = spawnSync(
  'python3',
  [
    '-c',
    `
import json,pathlib,sys,zipfile
root=pathlib.Path(sys.argv[1]);result=[]
for name in sys.argv[2:]:
 with zipfile.ZipFile(root/'dist'/name) as z:
  assert z.testzip() is None, 'Corrupt ZIP'
  names=z.namelist()
  assert len(names)==len(set(names)), 'Duplicate ZIP entry'
  for n in names:
   p=pathlib.PurePosixPath(n)
   assert not p.is_absolute() and '..' not in p.parts, 'Unsafe ZIP path'
   if name.endswith('.xpi'):
    assert n in ['LICENSE','bootstrap.js','manifest.json'] or n.startswith(('content/','bridge/','locale/','third-party/')), 'Unexpected XPI member: '+n
   else:
    assert n=='LICENSE' or n.startswith(('skills/zotero-paper-annotator/','skills/zotero-library-manager/')), 'Unexpected skill member: '+n
   result.append({'name':name+'!'+n,'text':z.read(n).decode('utf8')})
  if name.endswith('.xpi'):
   assert 'content/plugin.js' in names and 'bootstrap.js' in names and 'manifest.json' in names
  else:
   for skill in ['zotero-paper-annotator','zotero-library-manager']:
    assert 'skills/'+skill+'/SKILL.md' in names
print(json.dumps(result))
`,
    root,
    xpi,
    skills,
  ],
  { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
);
if (archiveScan.status !== 0) throw new Error(archiveScan.stderr || 'Archive inspection failed');
const members = JSON.parse(archiveScan.stdout);
for (const member of members) inspect(member.name, Buffer.from(member.text));
const updates = JSON.parse(await readFile(path.join(root, 'dist/updates.json'), 'utf8'));
const entry = updates.addons[manifest.applications.zotero.id].updates[0];
const digest = createHash('sha256')
  .update(await readFile(path.join(root, 'dist', xpi)))
  .digest('hex');
if (
  entry.version !== pkg.version ||
  entry.update_hash !== `sha256:${digest}` ||
  entry.update_link !==
    `https://github.com/DinoMax00/codex_for_zotero/releases/download/v${pkg.version}/${xpi}`
)
  throw new Error('Update manifest does not match the release');
const sums = await readFile(path.join(root, 'dist/SHA256SUMS'), 'utf8');
for (const name of [xpi, skills, 'updates.json']) {
  const hash = createHash('sha256')
    .update(await readFile(path.join(root, 'dist', name)))
    .digest('hex');
  if (!sums.includes(`${hash}  ${name}\n`)) throw new Error(`Checksum mismatch for ${name}`);
}
console.log(
  `Publication checks passed: ${files.length} source files and ${members.length} archive members; versions, update manifest, and SHA-256 checksums agree.`,
);
