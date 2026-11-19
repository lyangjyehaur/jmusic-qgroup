"""Explicit old-service erasure wrappers; no automatic environment activation."""
import json
from pathlib import Path

from tools.migration.rollback_erasure_authority import ErasureAuthority


def install_legacy_erasure_authority(authority, *, music_service=None, board_privacy=None, board_database=None):
    """Install only on an independently selected old-service rehearsal/version.

    Call the wrapped recover/replay before traffic, after restoring service
    files, and on every restart. Authority custody and native writer integration
    remain separate acceptance gates. This function does not start services.
    """
    if not isinstance(authority, ErasureAuthority) or not any((music_service, board_privacy)):
        raise ValueError('Explicit authority and old service required')
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
        def record_erasures(folder, qqs):
            if Path(folder) != music_folder:
                raise ValueError('Music erasure source differs from explicit authority binding')
            raw = ''.join(json.dumps({'qq': qq, 'erased_at': maintenance.time.time()}) + '\n' for qq in qqs).encode()
            try:
                authority.record('music', raw)
            except Exception:
                raise music_service.Rejected('刪除紀錄無法核對或保存，請先恢復並重新載入', 503) from None

        def replay(folder, store):
            if Path(folder) != music_folder or Path(store.path) != Path(music_service.STORE.path):
                raise ValueError('Music recovery source differs from explicit authority binding')
            authority.recover('music')
            return original_music_replay(folder, store)

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
        music_service._rollback_erasure_authority = authority

        def undo_music():
            maintenance.record_erasures = music_service.administration.record_erasures = original_music_record
            maintenance.replay = music_service.administration.replay = music_service.replay = original_music_replay
            music_service.administration.snapshot = original_snapshot
            del music_service._rollback_erasure_authority
        undo.append(undo_music)

    def uninstall():
        for action in reversed(undo):
            action()
        undo.clear()
    return uninstall
