import { parentPort, workerData } from 'node:worker_threads';
import { MusicCircles } from '@qgroup/contracts';
import { musicCircles, type MatchEntry, type MatchMember } from '@qgroup/domain';

export type CircleTask = { members: MatchMember[]; entries: MatchEntry[]; minLink: number };
export function runCircleTask({ members, entries, minLink }: CircleTask) {
  return MusicCircles.parse(musicCircles(members, entries, minLink));
}
if (parentPort) {
  try {
    // Refuse accidental inheritance of API credentials or process configuration.
    if (Object.keys(process.env).length > 0) throw new Error('Worker environment is not isolated');
    parentPort.postMessage({ ok: true, result: runCircleTask(workerData as CircleTask) });
  }
  catch { parentPort.postMessage({ ok: false }); }
}
