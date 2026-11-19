import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readRollbackErasureAuthority} from './rollback-erasure-authority';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root, pin, ...extra] = process.argv.slice(2);
  if (!root || !pin || extra.length) {
    process.stderr.write('Usage: npm run verify:rollback-erasure-authority -- <private-authority> <external-manifest-SHA256>\n');
    process.exitCode = 1;
  } else try {
    const result = readRollbackErasureAuthority(root, pin);
    result.assertUnchanged();
    process.stdout.write(JSON.stringify({status: 'verified_private_erasure_authority', manifestSha256: pin,
      sourcePackageSha256: result.manifest.sourcePackageSha256, records: result.head.sequence,
      rollbackEligible: false}) + '\n');
  } catch {
    process.stderr.write('Erasure authority verification rejected. Preserve the authority and service files; no service was activated.\n');
    process.exitCode = 1;
  }
}
