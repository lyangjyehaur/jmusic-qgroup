"""Read-only attendee profiles; event access is checked by the board handler."""
import base64
import http.client
import json
import os

from .common import APIError


def view(db, event, viewer, person_id):
    if not viewer:
        raise APIError('请先登录看板后查看成分', 401)
    person = db.execute('''SELECT a.user_id FROM attendees a
        WHERE a.id=? AND a.event_id=? AND a.status IN ('confirmed','waiting','tentative')''',
        (person_id, event['id'])).fetchone()
    if not person:
        raise APIError('报名不存在', 404)
    uid = person['user_id']
    if not uid or not db.execute('''SELECT 1 FROM users WHERE id=?
        AND NOT EXISTS(SELECT 1 FROM privacy_requests WHERE user_id=?)''', (uid, uid)).fetchone():
        return {'state': 'unlinked'}
    key = os.environ.get('KANBAN_MUSIC_PROXY_KEY', '')
    if len(key) < 32:
        raise APIError('成分站尚未开放', 404)
    context = base64.urlsafe_b64encode(json.dumps({
        'attendee_profile': {'viewer': viewer, 'target': uid}}).encode()).decode()
    connection = http.client.HTTPConnection('127.0.0.1', int(os.environ.get('KANBAN_MUSIC_PORT', '8788')), timeout=8)
    try:
        connection.request('GET', '/api/internal/attendee-profile', headers={
            'X-Music-Proxy-Key': key, 'X-Music-Identity': context})
        response = connection.getresponse()
        raw = response.read(1024*1024+1)
        if len(raw) > 1024*1024:
            raise ValueError()
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise ValueError()
        if response.status != 200:
            raise APIError(result.get('error', '成分暂时无法读取'), response.status)
        return result
    except (OSError, ValueError, http.client.HTTPException):
        raise APIError('成分站暂时无法连接，请稍后重试', 503) from None
    finally:
        connection.close()
