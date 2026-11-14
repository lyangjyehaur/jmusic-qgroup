"""Legacy settlement arithmetic and payment image validation."""
import json
import base64
import binascii
import re
import struct

from .common import APIError, now, string
from .events import has_ended
from . import audit, payment_codes


def money(cents):
    return ('-' if cents < 0 else '') + '%d.%02d' % (abs(cents) // 100, abs(cents) % 100)


def serialize_settlement(bill):
    per_person = (bill['total_cents'] * 2 + bill['headcount']) // (bill['headcount'] * 2)
    return dict(total_amount=money(bill['total_cents']), headcount=bill['headcount'],
        per_person_amount=money(per_person), rounding_difference_cents=per_person * bill['headcount'] - bill['total_cents'],
        has_qr=bool(bill['qr_size']), note=bill['note'], updated_at=bill['updated_at'], version=bill['version'])


def settlement_values(data):
    amount = data.get('total_amount')
    if not isinstance(amount, str) or not re.fullmatch(r'\d{1,7}(?:\.\d{1,2})?', amount, flags=re.ASCII):
        raise APIError('请填写有效总金额，最多保留两位小数')
    whole, _, fraction = amount.partition('.')
    cents = int(whole) * 100 + int(fraction.ljust(2, '0') or '0')
    headcount = data.get('headcount')
    if type(headcount) is not int or not 1 <= headcount <= 10000:
        raise APIError('请填写实际分摊人数（1–10000 人）')
    return cents, headcount


def qr_image(value):
    # Browser converts selected photos/screenshots to PNG. Only serve validated PNG data.
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > 2800000:
        raise APIError('收款码图片过大，请裁剪后重试')
    try:
        raw = base64.b64decode(value, validate=True)
        if len(raw) > 2 * 1024 * 1024 or raw[:8] != b'\x89PNG\r\n\x1a\n':
            raise ValueError()
        offset, chunks, has_data, finished = 8, 0, False, False
        while offset < len(raw):
            length = struct.unpack('>I', raw[offset:offset + 4])[0]
            kind = raw[offset + 4:offset + 8]
            stop = offset + 12 + length
            if stop > len(raw) or length > 2 * 1024 * 1024:
                raise ValueError()
            payload = raw[offset + 8:offset + 8 + length]
            crc = struct.unpack('>I', raw[offset + 8 + length:stop])[0]
            if binascii.crc32(kind + payload) & 0xffffffff != crc:
                raise ValueError()
            if chunks == 0:
                if kind != b'IHDR' or length != 13:
                    raise ValueError()
                width, height = struct.unpack('>II', payload[:8])
                if not 1 <= width <= 1600 or not 1 <= height <= 1600:
                    raise ValueError()
            elif kind == b'IHDR':
                raise ValueError()
            has_data = has_data or kind == b'IDAT'
            if kind == b'IEND':
                if length or stop != len(raw):
                    raise ValueError()
                finished = True
            offset, chunks = stop, chunks + 1
        if not finished or not has_data:
            raise ValueError()
        return raw
    except (ValueError, binascii.Error, struct.error):
        raise APIError('收款码图片格式不正确，请重新选择图片')


def save(db, event, user, data):
    from . import rooms
    if rooms.plan(db,event['id']):raise APIError('活动已设置包间，请刷新页面并核对实际包间后结算',409)
    if event['owner_id'] != user['id']:
        raise APIError('只有发起者可以填写结算',403)
    if not has_ended(event) and event['lifecycle']!='cancelled':
        raise APIError('活动结束后才能填写结算',409)
    if db.execute('SELECT 1 FROM settlement_details WHERE event_id=?',(event['id'],)).fetchone():
        raise APIError('此活动已采用逐人结算，请刷新页面，旧版不能覆盖逐人账单',409)
    if 'payment_codes' in data:raise APIError('请使用逐人结算选择收款方式',409)
    if 'headcount' not in data:
        data['headcount'] = db.execute("SELECT count(*) FROM attendees WHERE event_id=? AND status='confirmed'",(event['id'],)).fetchone()[0]
    total, count = settlement_values(data)
    existing = db.execute('SELECT * FROM settlements WHERE event_id=?',(event['id'],)).fetchone()
    current_version = db.execute('SELECT COALESCE(MAX(version),0) FROM settlement_history WHERE event_id=?',(event['id'],)).fetchone()[0]
    if 'base_version' in data:
        if type(data['base_version']) is not int or data['base_version'] < 0:
            raise APIError('结算版本格式不正确，请刷新页面重试')
        if data['base_version'] != current_version:
            raise APIError('结算已在其他页面更新，请保留需要的内容后载入最新结算。',409)
    note = string(data,'note',1000,False) if 'note' in data else (existing['note'] if existing else '')
    codes=payment_codes.resolve(db,event,user,data,current_version)
    previous_codes=payment_codes.existing(db,event['id'],current_version)
    prior_image=previous_codes[0][1] if previous_codes else None
    image=codes[0][1] if codes else None
    fields = [('total_amount','total_cents',total),('headcount','headcount',count),('note','note',note),('qr_image','qr_image',image)]
    changed = [name for name,column,value in fields if not existing or (prior_image if column=='qr_image' else existing[column])!=value]
    if not changed:
        return
    stamp, version = now(), current_version+1
    db.execute('''INSERT INTO settlement_history(event_id,version,total_cents,headcount,note,qr_image,
        updated_at,actor_id,actor_name,kind,changed_fields) VALUES(?,?,?,?,?,?,?,?,?,?,?)''',
        (event['id'],version,total,count,note,None,stamp,user['id'],user['nickname'],
         'edited' if existing else 'published',json.dumps(changed)))
    db.execute('''INSERT INTO settlements(event_id,total_cents,headcount,qr_image,note,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(event_id) DO UPDATE SET total_cents=excluded.total_cents,headcount=excluded.headcount,
        qr_image=excluded.qr_image,note=excluded.note,updated_at=excluded.updated_at''', (event['id'],total,count,None,note,stamp))
    payment_codes.attach(db,event['id'],version,codes)
    before = dict(version=current_version,total_amount=money(existing['total_cents']),headcount=existing['headcount'],
        note=existing['note'],has_qr=bool(prior_image)) if existing else {}
    audit.append(db,event,user,'settlement_saved',before,
        dict(version=version,total_amount=money(total),headcount=count,note=note,has_qr=bool(image)))


