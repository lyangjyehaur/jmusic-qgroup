import { type Viewer } from '@qgroup/contracts';
import { ApiError } from './api';
import { adminReadHttp } from './admin';

/** Missing music must not hide an administrator's pending acknowledgement. */
export async function readAdminMusicProfile(id: string, viewer: Viewer, signal?: AbortSignal) {
  try {
    return await adminReadHttp(viewer).requestContract('GET /api/v2/admin/music/:id', { params: { id }, signal });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && error.code === 'PROFILE_NOT_FOUND') return null;
    throw error;
  }
}
