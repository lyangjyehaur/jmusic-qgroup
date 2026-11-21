import { parentPort, workerData } from 'node:worker_threads';
import { musicRoomAnalysis, musicRoomSplit, type RoomMember, type MatchEntry } from '@qgroup/domain';
import { RoomLabCommand, RoomLabResult } from '@qgroup/contracts';
import type { z } from 'zod';
export type RoomTask = {
  input: z.infer<typeof RoomLabCommand>;
  members: RoomMember[];
  entries: MatchEntry[];
};
export function runRoomTask({ input, members, entries }: RoomTask) {
  const analysis = input.command === 'analyze' ? musicRoomAnalysis(input.selected, members, entries) : null;
  const rooms =
    input.command === 'analyze'
      ? []
      : input.command === 'recalc'
        ? input.rooms
        : musicRoomSplit(input.selected, members, entries, input.config, input.sameGender).rooms.map((room, index) => ({
            id: '00000000-0000-4000-8000-' + String(index).padStart(12, '0'),
            capacity: room.capacity,
            members: room.ids,
          }));
  return RoomLabResult.parse({
    sourceVersion: input.sourceVersion,
    selected: input.selected,
    analysis,
    rooms: rooms.map((room) => ({
      ...room,
      analysis: musicRoomAnalysis(room.members, members, entries),
    })),
    unassigned: input.selected.filter((id) => !rooms.some((room) => room.members.includes(id))),
    algorithm: 'music-rooms-v1',
  });
}
if (parentPort) {
  try {
    if (Object.keys(process.env).length > 0) throw new Error('Worker environment is not isolated');
    parentPort.postMessage({
      ok: true,
      result: runRoomTask(workerData as RoomTask),
    });
  } catch {
    parentPort.postMessage({ ok: false });
  }
}
