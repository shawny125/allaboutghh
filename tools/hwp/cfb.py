"""최소 기능 CFB(OLE 복합문서) 리더 — 외부 패키지 없이 동작."""
import struct

class CFB:
    def __init__(self, path):
        self.data = open(path, 'rb').read()
        h = self.data[:512]
        assert h[:8] == b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1', 'CFB 서명 불일치'
        self.sector_size = 1 << struct.unpack_from('<H', h, 30)[0]
        self.mini_sector_size = 1 << struct.unpack_from('<H', h, 32)[0]
        self.dir_start = struct.unpack_from('<I', h, 48)[0]
        self.mini_cutoff = struct.unpack_from('<I', h, 56)[0]
        self.mini_fat_start = struct.unpack_from('<I', h, 60)[0]
        self.mini_fat_count = struct.unpack_from('<I', h, 64)[0]
        self.difat_start = struct.unpack_from('<I', h, 68)[0]
        self.difat_count = struct.unpack_from('<I', h, 72)[0]
        self.fat_count = struct.unpack_from('<I', h, 44)[0]
        self._load_fat()
        self._load_dir()
        self._load_minifat()

    def _sector(self, n):
        off = 512 + n * self.sector_size
        return self.data[off:off + self.sector_size]

    def _load_fat(self):
        difat = list(struct.unpack_from('<109I', self.data, 76))
        nxt = self.difat_start
        for _ in range(self.difat_count):
            if nxt >= 0xFFFFFFFA: break
            sec = self._sector(nxt)
            per = self.sector_size // 4 - 1
            difat += list(struct.unpack_from(f'<{per}I', sec, 0))
            nxt = struct.unpack_from('<I', sec, self.sector_size - 4)[0]
        self.fat = []
        for s in difat:
            if s >= 0xFFFFFFFA: continue
            sec = self._sector(s)
            self.fat += list(struct.unpack_from(f'<{self.sector_size // 4}I', sec, 0))

    def _chain(self, start):
        out, cur, guard = [], start, 0
        while cur < 0xFFFFFFFA and guard < 1_000_000:
            out.append(cur)
            cur = self.fat[cur] if cur < len(self.fat) else 0xFFFFFFFE
            guard += 1
        return out

    def _read_chain(self, start, size=None):
        buf = b''.join(self._sector(s) for s in self._chain(start))
        return buf[:size] if size is not None else buf

    def _load_dir(self):
        raw = self._read_chain(self.dir_start)
        self.entries = []
        for i in range(0, len(raw), 128):
            e = raw[i:i + 128]
            if len(e) < 128: break
            nlen = struct.unpack_from('<H', e, 64)[0]
            name = e[:max(0, nlen - 2)].decode('utf-16-le', 'ignore')
            self.entries.append({
                'name': name,
                'type': e[66],
                'start': struct.unpack_from('<I', e, 116)[0],
                'size': struct.unpack_from('<Q', e, 120)[0],
                'child': struct.unpack_from('<I', e, 76)[0],
                'left': struct.unpack_from('<I', e, 68)[0],
                'right': struct.unpack_from('<I', e, 72)[0],
            })

    def _load_minifat(self):
        root = self.entries[0]
        self.mini_stream = self._read_chain(root['start'], root['size']) if root['size'] else b''
        raw = self._read_chain(self.mini_fat_start) if self.mini_fat_start < 0xFFFFFFFA else b''
        self.minifat = list(struct.unpack_from(f'<{len(raw)//4}I', raw, 0)) if raw else []

    def _read_mini(self, start, size):
        out, cur, guard = [], start, 0
        while cur < 0xFFFFFFFA and guard < 1_000_000:
            off = cur * self.mini_sector_size
            out.append(self.mini_stream[off:off + self.mini_sector_size])
            cur = self.minifat[cur] if cur < len(self.minifat) else 0xFFFFFFFE
            guard += 1
        return b''.join(out)[:size]

    def walk(self):
        """(경로, 엔트리) 목록"""
        res = []
        def rec(idx, prefix):
            if idx >= 0xFFFFFFFA or idx >= len(self.entries): return
            e = self.entries[idx]
            rec(e['left'], prefix)
            path = prefix + '/' + e['name'] if prefix else e['name']
            res.append((path, e))
            if e['type'] == 1:
                rec(e['child'], path)
            rec(e['right'], prefix)
        root = self.entries[0]
        rec(root['child'], '')
        return res

    def read(self, path):
        for p, e in self.walk():
            if p == path or p.endswith('/' + path) or e['name'] == path:
                if e['size'] < self.mini_cutoff:
                    return self._read_mini(e['start'], e['size'])
                return self._read_chain(e['start'], e['size'])
        raise KeyError(path)
