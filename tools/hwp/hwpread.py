"""HWP 5.0 BodyText 파서 — 표를 (행, 열) 격자로 복원한다."""
import struct, zlib, sys
sys.path.insert(0, '/home/claude/hwp')
from cfb import CFB

TAG_PARA_HEADER = 66
TAG_PARA_TEXT   = 67
TAG_CTRL_HEADER = 71
TAG_LIST_HEADER = 72
TAG_TABLE       = 77

CHAR_1  = {0, 10, 13}
INLINE  = {4, 5, 6, 7, 8, 9, 19, 20}
EXTEND  = {1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23}

def records(buf):
    i = 0
    while i + 4 <= len(buf):
        v = struct.unpack_from('<I', buf, i)[0]; i += 4
        tag = v & 0x3FF
        level = (v >> 10) & 0x3FF
        size = (v >> 20) & 0xFFF
        if size == 0xFFF:
            size = struct.unpack_from('<I', buf, i)[0]; i += 4
        yield tag, level, buf[i:i + size]
        i += size

def para_text(payload):
    out = []
    i = 0
    n = len(payload)
    while i + 1 < n:
        code = struct.unpack_from('<H', payload, i)[0]
        if code in CHAR_1:
            out.append('\n' if code == 13 else '')
            i += 2
        elif code in INLINE or code in EXTEND:
            i += 16
        elif code < 32:
            i += 2
        else:
            out.append(chr(code)); i += 2
    return ''.join(out)

def read_sections(path):
    c = CFB(path)
    fh = c.read('FileHeader')
    compressed = bool(struct.unpack_from('<I', fh, 36)[0] & 1)
    out = []
    for p, e in c.walk():
        if p.startswith('BodyText/Section'):
            raw = c.read(p)
            out.append((p, zlib.decompress(raw, -15) if compressed else raw))
    out.sort(key=lambda x: x[0])
    return out

def parse(path):
    """[{'type':'table','rows':R,'cols':C,'grid':{(r,c):text}} | {'type':'text','text':..}] 순서대로"""
    blocks = []
    for name, buf in read_sections(path):
        tables = []          # 스택: {'level':L,'rows':..,'cols':..,'grid':{}, 'cur':None}
        pending_table_level = None
        loose = []
        for tag, level, payload in records(buf):
            # 표 컨트롤 시작
            if tag == TAG_CTRL_HEADER and len(payload) >= 4:
                cid = payload[:4][::-1].decode('ascii', 'ignore')
                if cid == 'tbl ':
                    pending_table_level = level
                continue
            if tag == TAG_TABLE:
                rows, cols = struct.unpack_from('<HH', payload, 4)
                tables.append({'level': pending_table_level if pending_table_level is not None else level,
                               'rows': rows, 'cols': cols, 'grid': {}, 'cur': None})
                blocks.append({'type': 'table', 'ref': tables[-1]})
                pending_table_level = None
                continue
            if tag == TAG_LIST_HEADER and tables:
                t = tables[-1]
                if len(payload) >= 16:
                    col, row, cspan, rspan = struct.unpack_from('<HHHH', payload, 8)
                    t['cur'] = (row, col)
                continue
            if tag == TAG_PARA_TEXT:
                txt = para_text(payload)
                if tables and tables[-1]['cur'] is not None:
                    t = tables[-1]
                    k = t['cur']
                    t['grid'][k] = (t['grid'].get(k, '') + ' ' + txt).strip()
                else:
                    loose.append(txt)
                    blocks.append({'type': 'text', 'text': txt})
                continue
            # 표보다 얕은 레벨의 문단이 나오면 표 종료
            if tag == TAG_PARA_HEADER and tables and level <= tables[-1]['level']:
                tables.pop()
    return blocks

def dump(path, limit_tables=99):
    for b in parse(path):
        if b['type'] == 'text':
            t = b['text'].strip()
            if t: print('¶', t)
        else:
            t = b['ref']
            print(f"\n[표 {t['rows']}행 x {t['cols']}열]")

if __name__ == '__main__':
    dump(sys.argv[1])
