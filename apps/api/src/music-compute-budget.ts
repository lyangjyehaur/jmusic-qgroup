/** Shared by circles and rooms in one API instance. No queue: a caller must
 * retry after existing work stops. This limits threads, not process RSS. */
export function createMusicComputeBudget() {
  let active = 0;
  return {
    available: () => active < 2,
    acquire() {
      if (active >= 2) return null;
      active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active--;
      };
    },
  };
}
export type MusicComputeBudget = ReturnType<typeof createMusicComputeBudget>;
