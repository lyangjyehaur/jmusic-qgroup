// Development/Vitest bootstrap; the production worker bundles the task directly.
import { tsImport } from 'tsx/esm/api';
await tsImport('./music-circle-task.ts', import.meta.url);
