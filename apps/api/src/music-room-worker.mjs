// Development/Vitest bootstrap. The built worker bundles the task directly.
import { tsImport } from 'tsx/esm/api';
await tsImport('./music-room-task.ts', import.meta.url);
