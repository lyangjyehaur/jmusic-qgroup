import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { exerciseRetainedPython } from './retained-python-scenarios.mjs';
import { syntheticImageFixture } from './synthetic-image-fixture.mjs';

const args = process.argv.slice(2);
assert(args.length === 6 && args[0] === '--web-image' && args[2] === '--python-image' && args[4] === '--commit',
  'Use --web-image <complete ID> --python-image <complete ID> --commit <complete SHA>');
const webImage = args[1], pythonImage = args[3], commit = args[5];
assert([webImage, pythonImage].every(id => /^sha256:[a-f0-9]{64}$/.test(id)) && /^[a-f0-9]{40}$/.test(commit));
assert.notEqual(webImage, pythonImage);
const pythonCommit = '8da877857f163853c449474e168534e2e493121b';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const harnessPaths = ['verify-retained-python-images.mjs', 'retained-python-scenarios.mjs', 'retained-python-recovery.mjs', 'retained-worker-handoff.mjs', 'native-outbox-fixture.mjs', 'synthetic-image-fixture.mjs'];
const harnessPins = harnessPaths.map(name => {
  const path = 'tools/rebuild/' + name, bytes = readFileSync(new URL(name, import.meta.url));
  assert(bytes.equals(execFileSync('git', ['show', commit + ':' + path], { maxBuffer: 1024 * 1024 })), path);
  return { path, sha256: hash(bytes) };
});
const nativeFixturePath = fileURLToPath(new URL('./native-outbox-fixture.mjs', import.meta.url));
const docker = (...argv) => execFileSync('docker', argv, { encoding: 'utf8', timeout: 30000,
  maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const context = docker('context', 'show');
const endpoint = JSON.parse(docker('context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}'));
assert(endpoint.startsWith('unix://'), 'Only a local Unix Docker engine may run this rehearsal');
const specs = [webImage, pythonImage].map(image => JSON.parse(docker('image', 'inspect', image))[0]);
for (const [i, spec] of specs.entries()) {
  assert.equal(spec.Id, [webImage, pythonImage][i]); assert.equal(spec.Os, 'linux');
  assert.equal(spec.Config.User, 'qgroupsvc'); assert.equal(spec.Architecture, specs[0].Architecture);
  assert.equal(spec.Config.Labels['org.opencontainers.image.revision'], [commit, pythonCommit][i]);
}
assert.equal(specs[1].Config.Labels['qgroup.verification.revision'], commit);
const id = 'qgroup-python-pair-' + randomUUID(), web = id + '-web', bot = id + '-bot';
const volume = id + '-data', authorityVolume = id + '-authority', checkpointVolume = id + '-checkpoint';
const origin = 'http://127.0.0.1:8791', database = '/var/lib/qgroup/synthetic.sqlite3';
const limits = ['--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
  '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--pids-limit', '128',
  '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m', '--platform', 'linux/' + specs[0].Architecture];
const sourceProbe = String.raw`
import asyncio,hashlib,importlib.metadata,json,os,pathlib,socket,sys
root=pathlib.Path('/app/original-python'); manifest=json.loads(pathlib.Path('/app/retained-source.json').read_text())
actual=[]
for path in sorted(root.rglob('*')):
    assert not path.is_symlink()
    if path.is_file(): actual.append(dict(path=str(path.relative_to(root)),sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
assert actual == manifest['pythonSourcePins']
assert len(actual)==55 and manifest['pythonCommit']=='8da877857f163853c449474e168534e2e493121b'
fixture=hashlib.sha256(pathlib.Path('/app/retained-python-fixture.py').read_bytes()).hexdigest()
assert fixture == manifest['fixtureSha256']
assert hashlib.sha256(pathlib.Path('/app/original-Dockerfile').read_bytes()).hexdigest() == manifest['originalDockerfileSha256']
assert manifest['dependency'] == dict(name='websockets',version='17.4')
assert importlib.metadata.version('websockets') == '17.4'
def denied(*_args, **_kwargs): raise AssertionError('Source probe cannot use network')
socket.socket=denied
sys.path.insert(0,str(root))
from qgroup_bot import main
assert pathlib.Path(main.__file__).resolve() == root / 'qgroup_bot/main.py'
assert callable(main.ws_connect())
print(json.dumps(dict(manifest=manifest,manifestSha256=hashlib.sha256(pathlib.Path('/app/retained-source.json').read_bytes()).hexdigest(),fixtureSha256=fixture,gatewayDependencyAvailable=True,dependencyVersion='17.4',networkTransport='denied',uid=os.getuid(),gid=os.getgid(),python=sys.version)))
`;
const containers = [], ownedContainers = [], volumes = []; let failure, result;
function cleanupOwned() {
  const errors = [];
  const cleanupDocker = (...argv) => execFileSync('docker', argv, { encoding: 'utf8', timeout: 3000,
    stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  for (const name of [...ownedContainers].reverse()) try {
    const inventory = () => cleanupDocker('container', 'ls', '--all', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}');
    if (inventory()) cleanupDocker('rm', '-f', name); assert.equal(inventory(), '');
  } catch (error) { errors.push(error); }
  for (const volume of [...volumes].reverse()) try {
    cleanupDocker('volume', 'rm', volume);
    assert.equal(cleanupDocker('volume', 'ls', '--filter', 'name=^' + volume + '$', '--format', '{{.Name}}'), '');
  } catch (error) { errors.push(error); }
  return errors;
}
// A bounded external timeout must still remove this invocation's exact names.
// Synchronous Docker calls are themselves bounded; no label-wide cleanup runs.
const interrupted = () => {
  const errors = cleanupOwned();
  process.stderr.write('Image pair interrupted; cleanup ' + (errors.length ? 'incomplete' : 'verified') + '\n');
  process.exit(1);
};
process.once('SIGTERM', interrupted); process.once('SIGINT', interrupted);
try {
  ownedContainers.push(id + '-source');
  const source = JSON.parse(docker('run', '--rm', '--name', id + '-source', ...limits, '--entrypoint', 'python', pythonImage, '-c', sourceProbe));
  assert.equal(source.uid, 994); assert.equal(source.gid, 992); assert.equal(source.manifest.verificationCommit, commit);
  for (const v of [volume, authorityVolume, checkpointVolume]) {
    docker('volume', 'create', '--label', 'qgroup.rehearsal=true', v); volumes.push(v);
  }
  ownedContainers.push(id + '-fixture');
  const fixture = JSON.parse(docker('run', '--rm', '--name', id + '-fixture', ...limits, '-v', volume + ':/var/lib/qgroup',
    '-v', authorityVolume + ':/var/lib/qgroup-erasure', '-v', checkpointVolume + ':/var/lib/qgroup-checkpoint',
    '--entrypoint', 'node', webImage, '--input-type=module', '-e', syntheticImageFixture,
    database, '/var/lib/qgroup-erasure', '/var/lib/qgroup-checkpoint', 'retained-python'));
  assert(fixture.synthetic && fixture.uid === 994 && fixture.gid === 992);
  const rescue = 'synthetic-image-rescue-' + randomUUID();
  containers.push(web); ownedContainers.push(web);
  docker('run', '-d', '--name', web, '--label', 'qgroup.rehearsal=true', '--init', '--stop-timeout', '15', ...limits,
    '--mount', 'type=bind,src=' + nativeFixturePath + ',dst=/app/tools/rebuild/native-outbox-fixture.mjs,readonly',
    '-v', volume + ':/var/lib/qgroup', '-v', authorityVolume + ':/var/lib/qgroup-erasure',
    '-v', checkpointVolume + ':/var/lib/qgroup-checkpoint:ro',
    '-e', 'REBUILD_DB=' + database, '-e', 'REBUILD_ORIGIN=' + origin, '-e', 'REBUILD_PORT=8791',
    '-e', 'REBUILD_ERASURE_AUTHORITY_ROOT=/var/lib/qgroup-erasure',
    '-e', 'REBUILD_ERASURE_AUTHORITY_MANIFEST_SHA256=' + fixture.manifestSha256,
    '-e', 'REBUILD_ERASURE_AUTHORITY_CHECKPOINT=/var/lib/qgroup-checkpoint/unified.sqlite3',
    '-e', 'REBUILD_ADMIN_KEY_HASH=' + hash(rescue), '-e', 'REBUILD_BOT_ENABLED=1',
    '-e', 'REBUILD_BOT_KEYBOARD=1', '-e', 'REBUILD_BOT_PERSONAL_QUEUE=1', webImage);
  let ready = false;
  for (let n = 0; n < 60; n++) {
    const probe = spawnSync('docker', ['exec', web, 'node', '-e',
      "fetch('http://127.0.0.1:8791/api/v2/health',{signal:AbortSignal.timeout(1000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
      { timeout: 3000, stdio: 'ignore' });
    if (probe.status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert(ready, 'Isolated web image failed to become healthy');
  const nativeMount = JSON.parse(docker('inspect', web, '--format', '{{json .Mounts}}')).find(mount => mount.Destination === '/app/tools/rebuild/native-outbox-fixture.mjs');
  assert.equal(nativeMount.Type, 'bind'); assert.equal(nativeMount.Source, nativeFixturePath); assert.equal(nativeMount.RW, false);
  const mountedFixtureSha256 = docker('exec', web, 'node', '-e', "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('/app/tools/rebuild/native-outbox-fixture.mjs')).digest('hex'))");
  assert.equal(mountedFixtureSha256, harnessPins.find(pin => pin.path === 'tools/rebuild/native-outbox-fixture.mjs').sha256);
  const nativeFixtureMount = { readOnly: true, sha256: mountedFixtureSha256, runtimeSource: 'web-image' };
  containers.push(bot); ownedContainers.push(bot);
  docker('run', '-d', '--name', bot, '--label', 'qgroup.rehearsal=true', '--init', '--stop-timeout', '15', ...limits,
    '-v', volume + ':/var/lib/qgroup', '-e', 'KANBAN_BOT_BASE_URL=' + origin, pythonImage);
  const rows = (sql, ...values) => JSON.parse(docker('exec', web, 'node', '-e',
    "const Database=require('better-sqlite3'),[sql,values]=JSON.parse(process.argv[1]),db=new Database(process.env.REBUILD_DB,{readonly:true});try{console.log(JSON.stringify(db.prepare(sql).all(...values)))}finally{db.close()}",
    JSON.stringify([sql, values])));
  assert.deepEqual(rows('SELECT id FROM users ORDER BY id').map(row => row.id), ['alice', 'bob']);
  const runtimePins = JSON.parse(docker('exec', web, 'node', '-e',
    "const fs=require('fs'),hash=b=>require('crypto').createHash('sha256').update(b).digest('hex');console.log(JSON.stringify(['api/start.mjs','api/database.mjs'].map(path=>({path,sha256:hash(fs.readFileSync('.rebuild-dist/'+path))}))))"));
  let httpCalls = 0, originalWorkerInvocations = 0, nativeWorkerInvocations = 0;
  const request = async (url, options = {}) => {
    assert.equal(new URL(url).origin, origin);
    const { signal: _signal, ...input } = options;
    const response = JSON.parse(docker('exec', web, 'node', '-e',
      "(async()=>{const [url,input]=JSON.parse(process.argv[1]),r=await fetch(url,{...input,signal:AbortSignal.timeout(5000)});console.log(JSON.stringify({status:r.status,headers:[...r.headers].filter(([k])=>k!=='set-cookie'),cookies:r.headers.getSetCookie(),body:await r.text()}))})().catch(e=>{console.error(e);process.exit(1)})",
      JSON.stringify([url, input])));
    httpCalls++;
    const headers = new Headers(response.headers); for (const value of response.cookies) headers.append('Set-Cookie', value);
    return new Response(response.body, { status: response.status, headers });
  };
  const python = (mode, event, fault = 'success') => {
    originalWorkerInvocations++;
    return JSON.parse(docker('exec', bot, 'python', '/app/retained-python-fixture.py',
      '/app/original-python', database, mode, event, origin, fault));
  };
  const native = (mode, fault = 'success') => {
    nativeWorkerInvocations++;
    return JSON.parse(docker('exec', web, 'node', '/app/tools/rebuild/native-outbox-fixture.mjs', database, mode, origin, fault));
  };
  const scenario = await exerciseRetainedPython({ origin, rescue, rows, python, native, fetch: request });
  assert.equal(scenario.webRuntime.commit, commit); assert.equal(scenario.webRuntime.source, 'rehearsal');
  assert.equal(scenario.webRuntime.tree, source.manifest.verificationTree);
  assert.deepEqual(JSON.parse(docker('exec', bot, 'python', '-c', sourceProbe)), source);
  const afterRuntime = JSON.parse(docker('exec', web, 'node', '-e',
    "const fs=require('fs'),hash=b=>require('crypto').createHash('sha256').update(b).digest('hex');console.log(JSON.stringify(['api/start.mjs','api/database.mjs'].map(path=>({path,sha256:hash(fs.readFileSync('.rebuild-dist/'+path))}))))"));
  assert.deepEqual(afterRuntime, runtimePins);
  const running = containers.map(name => JSON.parse(docker('inspect', name))[0]);
  for (const [i, spec] of running.entries()) {
    assert.equal(spec.Image, [webImage, pythonImage][i]); assert.equal(spec.Config.User, 'qgroupsvc');
    assert.equal(spec.HostConfig.NetworkMode, 'none'); assert(Object.values(spec.NetworkSettings.Ports ?? {}).every(value => value === null));
    assert(spec.HostConfig.ReadonlyRootfs); assert.equal(spec.HostConfig.Memory, 512 * 1024 * 1024);
    assert.equal(spec.HostConfig.MemorySwap, spec.HostConfig.Memory); assert.equal(spec.HostConfig.NanoCpus, 1e9);
    assert.equal(spec.HostConfig.PidsLimit, 128); assert.deepEqual(spec.HostConfig.CapDrop, ['ALL']);
    assert(spec.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
    assert.equal(spec.Mounts.find(m => m.Destination === '/var/lib/qgroup')?.Name, volume);
    const binds = spec.Mounts.filter(m => m.Type === 'bind');
    assert.equal(binds.length, i === 0 ? 1 : 0);
    if (i === 0) {
      assert.equal(binds[0].Source, nativeFixturePath);
      assert.equal(binds[0].Destination, '/app/tools/rebuild/native-outbox-fixture.mjs');
      assert.equal(binds[0].RW, false);
    }
  }
  assert.equal(running[0].Mounts.find(m => m.Destination === '/var/lib/qgroup-checkpoint')?.RW, false);
  assert.equal(running[1].Mounts.filter(m => m.Type === 'volume').length, 1);
  const exits = [];
  for (const name of [...containers].reverse()) {
    docker('stop', '--time', '15', name); const spec = JSON.parse(docker('inspect', name))[0];
    assert.equal(spec.State.ExitCode, 0); assert(!spec.State.OOMKilled); exits.push({ service: name === bot ? 'python' : 'web', code: 0 });
  }
  result = { version: 1, commit, pythonCommit, imageCombination: { web: webImage, python: pythonImage },
    architecture: specs[0].Architecture, pythonSource: source, runtimePins, harnessPins, nativeFixtureMount, fixture, ...scenario, httpCalls, originalWorkerInvocations, nativeWorkerInvocations,
    separateActualImages: true, sharedSyntheticDatabase: true, networkTransport: 'denied', network: 'none',
    actualQQ: false, actualOnlineBotVersionKnown: false, fullB01ToB15Accepted: false,
    scope: 'none', releaseEligible: false, gracefulStops: exits };
} catch (error) {
  failure = error;
  for (const name of containers) {
    const log = spawnSync('docker', ['logs', '--tail', '80', name], { timeout: 10000, encoding: 'utf8' });
    process.stderr.write('Isolated pair diagnostics: ' + name + '\n' + (log.stdout ?? '').slice(-12000) + (log.stderr ?? '').slice(-12000));
  }
  throw error;
} finally {
  const errors = cleanupOwned();
  process.removeListener('SIGTERM', interrupted); process.removeListener('SIGINT', interrupted);
  if (errors.length) throw new AggregateError([...(failure ? [failure] : []), ...errors], 'Image pair cleanup incomplete');
}
process.stdout.write(JSON.stringify({ ...result, cleanupVerified: true }) + '\n');
