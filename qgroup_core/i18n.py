"""Display-only Chinese variants. Never convert arbitrary stored/user strings."""
import json
import re
from functools import lru_cache
from pathlib import Path


def language(header):
    preferred=[]
    for index,item in enumerate((header or '').split(',')):
        parts=item.strip().split(';')
        tag=parts[0].strip().lower().replace('_','-')
        quality=1.0
        try:
            for parameter in parts[1:]:
                if parameter.strip().startswith('q='):quality=float(parameter.strip()[2:])
        except ValueError:
            continue
        if tag and 0<quality<=1:preferred.append((-quality,index,tag))
    tag=min(preferred)[2] if preferred else ''
    pieces=tag.split('-')
    simplified=pieces[0]=='zh' and 'hant' not in pieces and ('hans' in pieces or 'chs' in pieces or any(p in ('cn','sg') for p in pieces))
    return 'hans' if simplified else 'hant'


@lru_cache(maxsize=1)
def catalogs():
    return json.loads(Path(__file__).with_name('locales.json').read_text())


def text(value,locale):
    return catalogs()[locale].get(value,value)


def template(value,parts,locale):
    """Translate known system pieces while preserving interpolation byte-for-byte.

    Ambiguous legacy sentences remain original rather than guess user boundaries.
    Leading/trailing fixed pieces have unambiguous boundaries; internal separators
    must occur exactly once. No user field is ever used as a dictionary key here.
    """
    for index,part in enumerate(parts):
        if part is not None and 0<index<len(parts)-1 and value.count(part)!=sum(piece==part for piece in parts):return None
    pattern=''.join('(.*?)' if part is None else re.escape(part) for part in parts)
    found=re.fullmatch(pattern,value,re.S)
    if not found:return None
    variables=iter(found.groups())
    return ''.join(next(variables) if part is None else text(part,locale) for part in parts)


ERROR_SUFFIXES=(
    ' 的份数、缺席／退出或约定差异需要核对原因',
    ' 的退款／减免超过其消费，请核对对应项目；预收款退款不应冲减消费',
    ' 的固定付款归属合计须等于其应付金额',
)
LABEL_PREFIXES=('报名 ','付款人 ')
BLOCKED_FRAGMENTS=('先发布核对后的逐人结算','旧人均账单需明确转换')


def error(value,locale):
    if value in catalogs()[locale]:return text(value,locale)
    for suffix in ERROR_SUFFIXES:
        if value.endswith(suffix):return value[:-len(suffix)]+text(suffix,locale)
    # Only finance-generated, numeric blockers use this joined error form.
    pieces=value.split('；')
    translated=[]
    for piece in pieces:
        if piece in catalogs()[locale]:translated.append(text(piece,locale));continue
        for prefix in ('尚有待补款 ¥','尚有应退／待偿还 ¥'):
            if piece.startswith(prefix) and re.fullmatch(r'[0-9]+\.[0-9]{2}',piece[len(prefix):]):
                translated.append(text(prefix,locale)+piece[len(prefix):]);break
        else:return value
    return '；'.join(translated)


CHANGE_LABELS=('类型','时间','时长','地点','注意事项','退出期限','时区','费用规则')


def arrangement(value,locale):
    if value in ('初始安排','原有安排','尚未发布的安排'):return text(value,locale)
    found=re.fullmatch(r'(.+?)已变更(：.*)?',value,re.S)
    if found:
        labels=found[1].split('、')
        if all(label in CHANGE_LABELS for label in labels):
            return '、'.join(text(label,locale) for label in labels)+text('已变更',locale)+(found[2] or '')
    return value


NOTIFICATIONS=(
    (None,' 已递补为正式报名'),
    (None,' 的报名认领申请待核对'),
    (None,' 的款项记录有更新，请查看收付款账本'),
    (None,' 已开始'),(None,' 已结束，请核对结算'),
    (None,' 已由发起者确认成团'),
    (None,' 已取消：',None,'；费用与退款以公布的结算为准'),
    (None,' 的协办权限已撤销：',None),
    (None,' 已由 ',None,' 接任发起者；你仍可管理自己的报名'),
    (None,' 已接受 ',None,' 的协办邀请'),
    (None,' 的退出申请已同意：',None),(None,' 的退出申请已拒绝：',None),
    (None,' 的报名已由发起者撤销：',None),
    (None,' 申请退出：',None),
    (None,' 暂不同意新安排：',None,'；原报名及原约定保留，请协调处理'),
    (None,' 已发布逐人结算第 ',None,' 版，请查看应付与付款归属'),
)


def notification(value,kind,locale):
    if kind=='claim_decided':
        for known in ('报名认领已通过，原名额及款项保留','报名认领已结束，请联系管理人'):
            if value==known:return text(known,locale)
    if kind=='conditions_changed':
        suffix='，请确认本人及代报名单的安排'
        if value.endswith(suffix):
            prior=value[:-len(suffix)]
            found=re.fullmatch(r'(.*)：((?:'+ '|'.join(CHANGE_LABELS)+r')(?:、(?:'+'|'.join(CHANGE_LABELS)+r'))*已变更)',prior,re.S)
            if found:return found[1]+'：'+arrangement(found[2],locale)+text(suffix,locale)
    for parts in NOTIFICATIONS:
        rendered=template(value,parts,locale)
        if rendered is not None:return rendered
    return value


CHANGES=(
    ('新增',None),('不再列入本版：',None),
    (None,'：应付 ',None,' → ',None,' 元；共同份数 ',None,' → ',None),
    ('称呼：',None,' → ',None),
    (None,' 付款归属：',None,' → ',None),
    (None,' 出席：',None,' → ',None),
    (None,' 接受约定版本已更新'),
    (None,' 核对原因：',None,' → ',None),
    (None,'：',None,' → ',None,' 元；分摊明细有调整'),
    (None,'：',None,' → ',None,' 元；分摊明细不变'),
    ('项目名称：',None,' → ',None),
    (None,'：消费凭证已变更，原图保留于旧版本'),
    (None,' 分摊依据：',None,' → ',None),
    (None,' 付款合计：',None,' → ',None,' 元'),
    ('付款人称呼：',None,' → ',None),
    ('备注：',None,' → ',None),
)


ATTENDANCE_LABELS={'unknown':'未登记','present':'到场','absent':'缺席','late':'迟到','left':'早退','left_early':'早退'}


def change(value,locale):
    status=re.fullmatch(r'(.*) 出席：(unknown|present|absent|late|left|left_early) → (unknown|present|absent|late|left|left_early)',value,re.S)
    if status:
        return status[1]+text(' 出席：',locale)+text(ATTENDANCE_LABELS[status[2]],locale)+' → '+text(ATTENDANCE_LABELS[status[3]],locale)
    # These two complete sentences contain no user interpolation.
    if value in ('发布逐人核对后的费用与付款归属；旧人均版本如有则保留原样。','收款码已变更，旧图仍可在历史版本查看','收款码或收款方式已变更，旧图仍可在历史版本查看'):
        return text(value,locale)
    for parts in CHANGES:
        rendered=template(value,parts,locale)
        if rendered is not None:return rendered
    return value


def payload(value,locale):
    if isinstance(value,list):return [payload(item,locale) for item in value]
    if not isinstance(value,dict):return value
    result={key:payload(item,locale) for key,item in value.items()}
    if 'default_template' in value and isinstance(value.get('kinds'),dict):
        result['kinds']={key:text(label,locale) for key,label in value['kinds'].items()}
        result['variables']={key:text(label,locale) for key,label in value['variables'].items()}
    if isinstance(value.get('error'),str):result['error']=error(value['error'],locale)
    if isinstance(value.get('rounding_rule'),str):result['rounding_rule']=text(value['rounding_rule'],locale)
    if isinstance(value.get('close_blockers'),list):result['close_blockers']=[error(item,locale) for item in value['close_blockers']]
    if isinstance(value.get('message'),str) and 'kind' in value:result['message']=notification(value['message'],value['kind'],locale)
    if isinstance(value.get('summary'),str):result['summary']=arrangement(value['summary'],locale)
    if isinstance(value.get('change_summary'),str):result['change_summary']=arrangement(value['change_summary'],locale)
    if isinstance(value.get('changes'),list):result['changes']=[change(item,locale) for item in value['changes']]
    # Same-name disambiguation is a system suffix; the name itself is untouched.
    if isinstance(value.get('label'),str) and isinstance(value.get('name'),str):
        name=value['name'];label=value['label']
        if label.startswith(name):
            suffix=label[len(name):]
            found=re.fullmatch(r'（(报名 |付款人 )([0-9]+)）',suffix)
            if found:result['label']=name+'（'+text(found[1],locale)+found[2]+'）'
    return result
