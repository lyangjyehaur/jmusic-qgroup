import { restorePairedBackup } from '../../apps/api/src/offline-restore';
const [backup, checkpoint, latestLedger, botEvidence, destination, assertion, ...extra] = process.argv.slice(2);
if (!backup || !checkpoint || !latestLedger || !botEvidence || !destination || assertion !== '--quiescent-copy' || extra.length) {
  process.stderr.write('Usage: npm run restore:rebuild -- <backup> <latest-checkpoint> <latest-ledger> <bot-evidence-directory> <new-directory> --quiescent-copy\n'); process.exitCode=1;
} else try {
  process.stdout.write(JSON.stringify(restorePairedBackup({backup,checkpoint,latestLedger,botEvidence,destination,quiescent:true}))+'\n');
} catch {
  process.stderr.write('Recovery rejected. Inspect private inputs and recovery rules; no service was started.\n'); process.exitCode=1;
}
