import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const args = process.argv.slice(2);
assert(args.length === 4 && args[0] === '--source' && args[2] === '--output',
  'Use --source <exact archived web context> --output <new absolute directory>');
const source = resolve(args[1]), output = args[3];
assert(isAbsolute(output) && !existsSync(output), 'New absolute output required');
const metadata = JSON.parse(readFileSync(join(source, 'release-source.json')));
assert(metadata.version === 1 && metadata.source === 'rehearsal' && /^[a-f0-9]{40}$/.test(metadata.commit));
const pythonCommit = '8da877857f163853c449474e168534e2e493121b';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { maxBuffer: 32 * 1024 * 1024 });
const inputs = ['tools/rebuild/retained-python-fixture.py', 'deploy/retained-python-rehearsal.Dockerfile'];
// A manifest beside a dirty checkout is insufficient: every harness input must
// also equal the declared commit blob before it enters the separate image.
for (const path of inputs) assert(readFileSync(join(source, path)).equals(git('show', metadata.commit + ':' + path)), path);
mkdirSync(output, { mode: 0o700 });
mkdirSync(join(output, 'original-python'), { mode: 0o700 });
execFileSync('tar', ['-xf', '-', '-C', join(output, 'original-python')], {
  input: git('archive', pythonCommit, 'qgroup_core', 'qgroup_bot'),
});
const paths = git('ls-tree', '-r', '--name-only', pythonCommit, '--', 'qgroup_core', 'qgroup_bot').toString().trim().split('\n');
assert.equal(paths.length, 55);
const pythonSourcePins = paths.map(path => {
  const bytes = readFileSync(join(output, 'original-python', path));
  assert(bytes.equals(git('show', pythonCommit + ':' + path)), path);
  // All verification files must be readable by the non-root image service.
  return { path, sha256: digest(bytes) };
});
const fixture = readFileSync(join(source, inputs[0]));
writeFileSync(join(output, 'retained-python-fixture.py'), fixture, { mode: 0o644, flag: 'wx' });
writeFileSync(join(output, 'Dockerfile'), readFileSync(join(source, inputs[1])), { mode: 0o644, flag: 'wx' });
const manifest = { version: 1, kind: 'qgroup-retained-python-rehearsal', pythonCommit,
  verificationCommit: metadata.commit, verificationTree: metadata.tree,
  pythonSourcePins, fixtureSha256: digest(fixture), inputs: inputs.map(path => ({ path, sha256: digest(readFileSync(join(source, path))) })),
  actualOnlineBotVersionKnown: false, actualQQ: false, releaseEligible: false };
writeFileSync(join(output, 'retained-source.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644, flag: 'wx' });
process.stdout.write(JSON.stringify(manifest) + '\n');
