"""Minimal board-facing profiles resolved from current identity mappings."""
from .identity_store import Rejected


def view(data, store, context, normalize, entry_kind):
    scope = context.get('attendee_profile')
    if not isinstance(scope, dict) or not all(isinstance(scope.get(k), str) and scope[k] for k in ('viewer', 'target')):
        raise Rejected('请从活动报名名单查看成分', 403)
    # Do not use linked_qq: profile reads must not promote OAuth prelinks.
    def member(db, uid):
        rows = db.execute('''SELECT qq FROM links WHERE user_id=?
            UNION SELECT qq FROM prelinks WHERE user_id=?''', (uid, uid)).fetchall()
        if len(rows) != 1:
            return None
        return data['members'].get(rows[0]['qq'])
    with store.connect() as db:
        db.execute('BEGIN')
        viewer = member(db, scope['viewer'])
        target = member(db, scope['target'])
    if not viewer:
        return {'state': 'viewer_unlinked'}
    if not target:
        return {'state': 'unlinked'}
    own = {pick['id'] for pick in normalize(viewer.get('selection', []))}
    picks = []
    for pick in normalize(target.get('selection', [])):
        entry = data['entries'].get(pick['id'])
        if entry:
            picks.append(dict(id=pick['id'], text=entry['text'], kind=entry_kind(entry),
                              level=pick['level'], shared=pick['id'] in own))
    return dict(state='ready', picks=picks, is_self=scope['viewer'] == scope['target'])
