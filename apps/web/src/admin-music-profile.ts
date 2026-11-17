import { AdminMusicProfile, type Viewer } from '@qgroup/contracts';
import { api, ApiError } from './api';

/** Missing music must not hide an administrator's pending acknowledgement. */
export async function readAdminMusicProfile(path: string, viewer: Viewer, signal?: AbortSignal) {
  try {
    return await api(path, AdminMusicProfile, { signal, headers: { 'X-Account-Scope': viewer.scope } });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && error.code === 'PROFILE_NOT_FOUND') return null;
    throw error;
  }
}
