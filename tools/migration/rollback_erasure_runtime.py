"""Explicit old-service erasure wrappers; no automatic environment activation."""
import json
from pathlib import Path

from tools.migration.rollback_erasure_authority import ErasureAuthority


def install_legacy_erasure_authority(authority, *, music_service=None, board_privacy=None, board_database=None, reset_source_vault=None):
    """Install only on an independently selected old-service rehearsal/version.

    Call the wrapped recover/replay before traffic, after restoring service
    files, and on every restart. Authority custody and native writer integration
    remain separate acceptance gates. This function does not start services.
    """
    if not isinstance(authority, ErasureAuthority) or not any((music_service, board_privacy)):
        raise ValueError('Explicit authority and old service required')
    if reset_source_vault is not None:
        from tools.migration.rollback_reset_source_vault import ResetSourceVault
        if not music_service or not isinstance(reset_source_vault, ResetSourceVault) or reset_source_vault.authority is not authority:
            raise ValueError('Explicit reset source vault and matching music authority required')
        reset_source_vault._guard()
    board_path = Path(board_database) if board_database is not None else None
    if board_privacy:
        if getattr(board_privacy, '_rollback_erasure_authority', None) is not None or board_path is None or not board_path.is_absolute() or board_path.resolve() != board_path or authority.sources.get('board') != board_path.with_suffix('.erasures.jsonl'):
            raise ValueError('Board authority binding or installation differs')
        original_board_journal, original_board_recover = board_privacy.journal, board_privacy.recover
    if music_service:
        from music_site import maintenance
        music_folder = Path(music_service.upstream.DATA_FILE).parent
        if getattr(music_service, '_rollback_erasure_authority', None) is not None or authority.sources.get('music') != music_folder / 'erasures.jsonl' or music_service.administration.record_erasures is not maintenance.record_erasures or music_service.administration.replay is not maintenance.replay or music_service.replay is not maintenance.replay:
            raise ValueError('Music authority binding or installation differs')
        original_music_record, original_music_replay = maintenance.record_erasures, maintenance.replay
        original_snapshot = music_service.administration.snapshot
        original_erase = music_service.administration.erase
    # Capture known live SQLite identities using lstat only. Ledger readers must
    # reject those inodes before opening any extra raw descriptor.
    sqlite_paths = [path for path in [board_path, Path(music_service.STORE.path) if music_service else None] if path is not None]
    authority.register_sqlite_files(sqlite_paths)
    undo = []
    if board_privacy:
        def journal(db, entry):
            actual = Path(next(row[2] for row in db.execute('PRAGMA database_list') if row[1] == 'main'))
            if actual != board_path:
                raise ValueError('Board journal database differs from explicit authority binding')
            try:
                authority.record('board', (json.dumps(entry, separators=(',', ':')) + '\n').encode())
            except Exception:
                from qgroup_core.common import APIError
                raise APIError('刪除紀錄無法核對或保存，請先恢復並重新載入', 503) from None

        def recover(path):
            if Path(path) != board_path:
                raise ValueError('Board recovery source differs from explicit authority binding')
            authority.recover('board')
            return original_board_recover(path)

        board_privacy.journal, board_privacy.recover = journal, recover
        board_privacy._rollback_erasure_authority = authority

        def undo_board():
            board_privacy.journal, board_privacy.recover = original_board_journal, original_board_recover
            del board_privacy._rollback_erasure_authority
        undo.append(undo_board)
    if music_service:
        handled_reset_pins = []
        pending_reset = None

        def require_known_resets():
            pins = [row['recordSha256'] for row in authority.music_reset_records()]
            expected = handled_reset_pins + ([pending_reset['recordSha256']] if pending_reset and 'recordSha256' in pending_reset else [])
            if pins != expected:
                raise music_service.Rejected('重設紀錄尚未完成恢復核對，請先保全原檔', 503)

        def record_erasures(folder, qqs):
            if Path(folder) != music_folder:
                raise ValueError('Music erasure source differs from explicit authority binding')
            try:
                require_known_resets()
                if pending_reset is None:
                    raw = ''.join(json.dumps({'qq': qq, 'erased_at': maintenance.time.time()}) + '\n' for qq in qqs).encode()
                    authority.record('music', raw)
                else:
                    from tools.migration.rollback_music_reset import capture_legacy_music_reset, _encode
                    if list(qqs) != list(music_service.upstream.data['members']):
                        raise ValueError('Original reset member scope changed')
                    source_path = music_folder / 'data.json'
                    source, identity = authority._read_file(source_path)
                    time = maintenance.time.time()
                    operation = capture_legacy_music_reset(source, music_service.upstream.data, time)
                    raw = ''.join(json.dumps({'qq': qq, 'erased_at': time}) + '\n' for qq in qqs).encode()
                    captured = None
                    if reset_source_vault is not None:
                        captured = reset_source_vault.capture(operation, source, _encode(music_service.upstream.data))
                        captured['assertCaptured']()
                        before, checked = authority._read_file(source_path)
                        if source != before or identity != checked or capture_legacy_music_reset(before, music_service.upstream.data, time) != operation:
                            raise ValueError('Original reset sources changed during durable capture')
                    recorded = authority.record('music', raw, operation=operation)
                    if captured is not None:
                        captured['assertCaptured']()
                    after, checked = authority._read_file(source_path)
                    if source != after or identity != checked or capture_legacy_music_reset(after, music_service.upstream.data, time) != operation:
                        raise ValueError('Original reset source changed during recording')
                    pending_reset.update(recorded)
                    if captured is not None:
                        pending_reset['capturedReset'] = captured
            except Exception:
                raise music_service.Rejected('刪除紀錄無法核對或保存，請先恢復並重新載入', 503) from None

        def replay(folder, store):
            if Path(folder) != music_folder or Path(store.path) != Path(music_service.STORE.path):
                raise ValueError('Music recovery source differs from explicit authority binding')
            with authority._held():
                require_known_resets()
                authority.recover('music')
                return original_music_replay(folder, store)

        def erase(folder, store, body, reset=False):
            nonlocal pending_reset
            # Preserve the original confirmation and missing-member responses.
            # The original HTTP handler owns its non-reentrant upstream lock.
            if not reset or body.get('confirm') != 'RESET':
                return original_erase(folder, store, body, reset=reset)
            if Path(folder) != music_folder or Path(store.path) != Path(music_service.STORE.path) or not music_service.upstream._lock.locked():
                raise music_service.Rejected('重設來源或維護鎖無法核對', 503)
            with authority._held():
                require_known_resets()
                if pending_reset is not None:
                    raise music_service.Rejected('重設尚未完成，請先恢復並重新載入', 503)
                pending_reset = {}
                try:
                    result = original_erase(folder, store, body, reset=True)
                    if any(music_service.upstream.data.get(name) for name in ('entries', 'members', 'shouts', 'shoutHistory', 'trend')) or 'recordSha256' not in pending_reset:
                        raise ValueError('Original reset did not complete')
                    if 'capturedReset' in pending_reset:
                        try:
                            source_path = music_folder / 'data.json'
                            completed, identity = authority._read_file(source_path)
                            pending_reset['capturedReset']['complete'](
                                {key: pending_reset[key] for key in ('sequence', 'recordSha256')}, completed, music_service.upstream.data)
                            after, checked = authority._read_file(source_path)
                            from tools.migration.rollback_music_reset import _encode
                            if completed != after or identity != checked or _encode(music_service.upstream.data) != _encode(json.loads(after)):
                                raise ValueError('Completed reset source changed during capture')
                        except Exception:
                            raise music_service.Rejected('重設結果尚未完成保全，請保留原檔與紀錄後恢復', 503) from None
                    handled_reset_pins.append(pending_reset['recordSha256'])
                    return result
                finally:
                    pending_reset = None

        def snapshot(folder, name=None, store=None):
            if Path(folder) != music_folder:
                raise ValueError('Music export source differs from explicit authority binding')
            try:
                from tools.migration.rollback_history_runtime import _download
                with authority.guard('music') as ledger:
                    return _download(music_service, music_folder, original_snapshot(folder, name, store), ledger)
            except music_service.Rejected:
                raise
            except Exception:
                raise music_service.Rejected('目前刪除紀錄無法核對，已停止匯出；請先保全原檔並恢復', 503) from None

        maintenance.record_erasures = music_service.administration.record_erasures = record_erasures
        maintenance.replay = music_service.administration.replay = music_service.replay = replay
        music_service.administration.snapshot = snapshot
        music_service.administration.erase = erase
        music_service._rollback_erasure_authority = authority

        def undo_music():
            maintenance.record_erasures = music_service.administration.record_erasures = original_music_record
            maintenance.replay = music_service.administration.replay = music_service.replay = original_music_replay
            music_service.administration.snapshot = original_snapshot
            music_service.administration.erase = original_erase
            del music_service._rollback_erasure_authority
        undo.append(undo_music)

    def uninstall():
        for action in reversed(undo):
            action()
        undo.clear()
    return uninstall
