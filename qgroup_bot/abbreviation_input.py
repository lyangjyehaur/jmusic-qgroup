"""Extract lookup terms from user-selected text without forwarding chat context."""
import re


IGNORED = re.compile(
    r'<@!?[^>]*>|<qqbot-at-[^>]*>'
    r'|(?:[a-z][a-z0-9+.-]*://|www\.)[^\s<>]+'
    r'|[A-Za-z0-9_.+%-]+@[A-Za-z0-9.-]+'
    r'|[@＠][A-Za-z0-9_]+'
    r'|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:[/?:#][^\s<>]*)?', re.I)
CONTINUATION = re.compile(r'^(?:继续|繼續|下一页|下一頁)(?:\s|$)')


def extract_argument(texts):
    terms = dict.fromkeys(
        token.lower()
        for text in texts if isinstance(text, str)
        for token in re.findall(r'[A-Za-z0-9_]+', IGNORED.sub(' ', text))
        if re.fullmatch(r'[A-Za-z0-9]{2,32}', token) and re.search(r'[A-Za-z]', token))
    # Keep every extracted term: the existing lookup validates the input count
    # and asks for a narrower query rather than silently dropping terms.
    return ','.join(terms)


def query_argument(argument):
    return argument if CONTINUATION.match(argument) else extract_argument([argument])


def has_quote(payload):
    scene = payload.get('message_scene')
    ext = scene.get('ext') if isinstance(scene, dict) else None
    return (payload.get('message_type') == 103 or
            isinstance(ext, list) and any(isinstance(value, str) and
                                        value.startswith('ref_msg_idx=') for value in ext))


def quoted_texts(payload):
    """Read only quote elements supplied by QQ; never fetch message history."""
    if not has_quote(payload):
        return None
    elements = payload.get('msg_elements')
    if not isinstance(elements, list):
        return []
    scene = payload.get('message_scene')
    ext = scene.get('ext', []) if isinstance(scene, dict) else []
    references = {value.partition('=')[2] for value in ext if isinstance(value, str)
                  and value.startswith('ref_msg_idx=')} if isinstance(ext, list) else set()
    selected = [element for element in elements if isinstance(element, dict)
                and isinstance(element.get('msg_idx'), str) and element['msg_idx'] in references]
    # QQ's documented example has an unindexed element containing the quote.
    # With indexed elements, don't fall back to unrelated messages.
    if references and not selected and any(isinstance(e, dict) and e.get('msg_idx') for e in elements):
        return []
    pending = list(reversed(selected or elements))
    texts, seen = [], set()
    while pending:
        element = pending.pop()
        if not isinstance(element, dict) or id(element) in seen:
            continue
        seen.add(id(element))
        if isinstance(element.get('content'), str):
            texts.append(element['content'])
        nested = element.get('msg_elements')
        if isinstance(nested, list):
            pending.extend(reversed(nested))
    return texts
