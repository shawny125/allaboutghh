#!/usr/bin/env python3
"""
학교 원본 파일(HWP/XLSX) -> 웹앱이 읽는 JSON 으로 변환합니다.
학기가 바뀌면 새 파일로 다시 돌리면 됩니다.

  python3 tools/hwp/build_data.py \
      --기초시간표 "1. 2학기 기초시간표 파일학급별.hwp" \
      --실제강의실 "2. ... 실제강의실.hwp" \
      --컴시간강의실 "3. ... 컴시간 상 강의실 배치.hwp" \
      --명렬표 "교사명렬표.xlsx"

만들어지는 파일 (모두 data/ 아래)
  base-timetable.json   기초시간표 (학급별 주간 시간표 + 이동수업 블록)
  electives.json        선택과목 블록 배치 + 실제/컴시간 강의실
  teacher-map.json      컴시간 마스킹 이름 -> 실명
  교사명렬표.csv          교직원 명단 + 담당 과목
  검증리포트.md           파일 사이 어긋난 부분 정리
"""
import sys, os, re, json, csv, argparse
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hwpread

DAYS = ['월', '화', '수', '목', '금']
PERIOD_MINUTES = 50


def norm(s):
    return re.sub(r'\s+', ' ', (s or '')).strip()


def nospace(s):
    return re.sub(r'\s+', '', (s or '')).strip()


def add_minutes(hhmm, m):
    h, mi = map(int, hhmm.split(':'))
    t = h * 60 + mi + m
    return f"{(t // 60) % 24:02d}:{t % 60:02d}"


# ────────────────────────────────────────────────── 기초시간표
def parse_base(path, roster_names):
    blocks = hwpread.parse(path)
    title, items = None, []
    for b in blocks:
        if b['type'] == 'text':
            t = norm(b['text'])
            if t:
                title = t
        else:
            items.append((title, b['ref']))

    lessons, periods, warn = [], {}, []
    for ttl, t in items:
        m = re.match(r'(\d)\s*학년\s*(\d+)\s*반', ttl or '')
        if not m:
            continue
        g, c = int(m.group(1)), int(m.group(2))
        for r in range(1, t['rows']):
            pm = re.match(r'(\d)\s*교시\s*\((\d{1,2}):(\d{2})\)', norm(t['grid'].get((r, 0), '')))
            if not pm:
                continue
            p = int(pm.group(1))
            periods[p] = f"{int(pm.group(2)):02d}:{pm.group(3)}"
            for d in range(1, 6):
                cell = norm(t['grid'].get((r, d), ''))
                if not cell:
                    continue
                if re.fullmatch(r'[A-E]', cell):
                    lessons.append({"g": g, "c": c, "d": d - 1, "p": p, "block": cell})
                    continue
                teacher, subject = None, cell
                parts = cell.split()
                for i, cand in enumerate(parts):
                    if cand in roster_names:
                        teacher = cand
                        subject = ' '.join(parts[:i] + parts[i + 1:]).strip()
                        break
                if teacher is None:
                    warn.append(f"교사 이름을 못 찾음: {g}-{c} {DAYS[d-1]} {p}교시 '{cell}'")
                lessons.append({"g": g, "c": c, "d": d - 1, "p": p,
                                "subject": subject, "teacher": teacher})
    return lessons, periods, warn


# ────────────────────────────────────────────────── 강의실 배치표
def parse_block_grid(t):
    out = defaultdict(dict)
    special = defaultdict(dict)
    for r in range(1, t['rows']):
        if not re.fullmatch(r'\d', norm(t['grid'].get((r, 0), ''))):
            continue
        p = int(norm(t['grid'][(r, 0)]))
        for c in range(1, 6):
            v = norm(t['grid'].get((r, c), ''))
            if not v:
                continue
            if re.fullmatch(r'[A-E]', v):
                out[c - 1][p] = v
            else:
                special[c - 1][p] = v
    return ({str(k): {str(p): b for p, b in v.items()} for k, v in out.items()},
            {str(k): {str(p): b for p, b in v.items()} for k, v in special.items()})


def parse_rooms(t):
    rooms = [norm(t['grid'].get((0, c), '')) for c in range(t['cols'])]
    out = {}
    for r in range(1, t['rows']):
        blk, start = None, None
        for c in (1, 0):
            m = re.match(r'^([A-E])\s*\(\d+\)$', norm(t['grid'].get((r, c), '')))
            if m:
                blk, start = m.group(1), c + 1
                break
        if not blk:
            continue
        d = {}
        for c in range(start, t['cols']):
            cell = norm(t['grid'].get((r, c), ''))
            if not cell:
                continue
            m = re.match(r'^(.*?)\s*\((\d+)\)$', cell)
            sub = norm(m.group(1)) if m else cell
            cnt = int(m.group(2)) if m else None
            d[sub] = {"room": rooms[c] or "(장소 미정)", "count": cnt}
        out[blk] = d
    return out


def parse_electives(real_path, comci_path):
    rt = [b['ref'] for b in hwpread.parse(real_path) if b['type'] == 'table']
    ct = [b['ref'] for b in hwpread.parse(comci_path) if b['type'] == 'table']
    # 실제 파일: 2학년 이동표, 2학년 배치, 3학년 이동표, 3학년 배치
    grid2, sp2 = parse_block_grid(rt[0])
    real2 = parse_rooms(rt[1])
    grid3, sp3 = parse_block_grid(rt[2])
    real3 = parse_rooms(rt[3])
    comci2, comci3 = parse_rooms(ct[0]), parse_rooms(ct[1])

    def merge(grid, special, real, comci):
        courses = {}
        for blk, subs in real.items():
            courses[blk] = {}
            for sub, info in subs.items():
                cm = comci.get(blk, {}).get(sub)
                courses[blk][sub] = {
                    "강의실": info["room"],
                    "컴시간강의실": cm["room"] if cm else None,
                    "정원": info["count"],
                    "다름": bool(cm and cm["room"] != info["room"]),
                }
        subjects = sorted({s for b in courses.values() for s in b})
        return {"블록배치": grid, "특수": special, "강좌": courses, "과목목록": subjects}

    return {"2": merge(grid2, sp2, real2, comci2),
            "3": merge(grid3, sp3, real3, comci3)}


# ────────────────────────────────────────────────── 보정
def apply_corrections(lessons, electives, corr):
    """원본 파일의 오류·표기 차이를 바로잡는다."""
    log = []

    # 1) 기초시간표 개별 칸 수정
    for fix in corr.get('기초시간표수정', []):
        g, c, d, p = fix['학년'], fix['반'], fix['요일'], fix['교시']
        found = False
        for l in lessons:
            if (l['g'], l['c'], l['d'], l['p']) == (g, c, d, p):
                before = l.get('block') or l.get('subject')
                l.pop('subject', None); l.pop('teacher', None)
                if '블록' in fix:
                    l['block'] = fix['블록']
                    after = fix['블록']
                else:
                    l['subject'] = fix.get('과목', '')
                    l['teacher'] = fix.get('교사')
                    after = l['subject']
                log.append(f"{g}-{c} {DAYS[d]} {p}교시: {before} → {after} ({fix.get('사유','')})")
                found = True
        if not found:
            log.append(f"⚠ 수정 대상 없음: {g}-{c} {DAYS[d]} {p}교시")

    # 2) 과목명 표기 통일
    rename = corr.get('과목명', {})
    if rename:
        n = 0
        for l in lessons:
            if l.get('subject') in rename:
                l['subject'] = rename[l['subject']]; n += 1
        for g, e in electives.items():
            for blk, subs in list(e['강좌'].items()):
                for old, new in rename.items():
                    if old in subs:
                        subs[new] = subs.pop(old); n += 1
            e['과목목록'] = sorted({s for b in e['강좌'].values() for s in b})
        log.append(f"과목명 통일 {n}건: " + ', '.join(f"{k}→{v}" for k, v in rename.items()))

    # 3) 컴시간에 비어 있지만 실제로는 있는 고정 수업 (창체 등)
    classes = {}
    for l in lessons:
        classes.setdefault(l['g'], set()).add(l['c'])
    for fx in corr.get('고정수업', []):
        d = fx['요일']
        grades = fx.get('학년') or sorted(classes)
        added = 0
        for g in grades:
            for c in sorted(classes.get(g, [])):
                for p in fx['교시']:
                    if any((l['g'], l['c'], l['d'], l['p']) == (g, c, d, p) for l in lessons):
                        continue
                    lessons.append({"g": g, "c": c, "d": d, "p": p,
                                    "subject": fx['과목'], "teacher": None, "고정": True})
                    added += 1
        log.append(f"고정수업 '{fx['과목']}' {DAYS[d]} {fx['교시']}교시 {added}칸 추가")

    lessons.sort(key=lambda l: (l['g'], l['c'], l['d'], l['p']))
    return lessons, electives, log


# ────────────────────────────────────────────────── 교사 매핑
def build_teacher_map(roster, lessons):
    subj = defaultdict(lambda: defaultdict(int))
    for l in lessons:
        if l.get('teacher'):
            subj[l['teacher']][l['subject']] += 1

    mask = defaultdict(list)
    for nm in roster:
        mask[nm[:-1] + '*'].append(nm)

    tmap, notes = {}, []
    for mk, names in sorted(mask.items()):
        teaching = [n for n in names if subj[n]]
        if len(names) == 1:
            tmap[mk] = names[0]
        elif len(teaching) == 1:
            tmap[mk] = teaching[0]
            notes.append(f"{mk}: {names} 중 수업이 있는 {teaching[0]} 로 확정")
        else:
            # 과목으로 가른다
            owner = {}
            ok = True
            for n in teaching:
                for s in subj[n]:
                    if s in owner:
                        ok = False
                    owner[s] = n
            if ok and owner:
                for s, n in owner.items():
                    tmap[f"{mk}|{s}"] = n
                notes.append(f"{mk}: {teaching} — 과목으로 구분")
            else:
                notes.append(f"⚠ {mk}: {names} — 과목으로도 못 가름. 직접 지정 필요")
    return tmap, subj, notes


# ────────────────────────────────────────────────── 검증
def validate(lessons, electives, subj, roster):
    lines = []
    grid_bad = []
    for l in lessons:
        if 'block' not in l:
            continue
        g = str(l['g'])
        if g not in electives:
            continue
        exp = electives[g]['블록배치'].get(str(l['d']), {}).get(str(l['p']))
        if exp != l['block']:
            grid_bad.append((l, exp))
    lines.append(f"## 이동수업 블록 위치 대조\n")
    if grid_bad:
        lines.append(f"기초시간표와 이동수업 배치표가 **{len(grid_bad)}칸** 어긋납니다.\n")
        for l, exp in grid_bad:
            lines.append(f"- {l['g']}학년 {l['c']}반 {DAYS[l['d']]} {l['p']}교시 — "
                         f"기초시간표 `{l['block']}` / 이동수업 배치표 `{exp}`")
    else:
        lines.append("어긋나는 칸 없음.")
    lines.append("")

    lines.append("## 컴시간 강의실과 실제 강의실 차이\n")
    diff = 0
    total = 0
    for g in ('2', '3'):
        for blk, subs in sorted(electives[g]['강좌'].items()):
            for s, info in sorted(subs.items()):
                total += 1
                if info['다름']:
                    diff += 1
                    lines.append(f"- {g}학년 {blk} {s} — 실제 **{info['강의실']}** "
                                 f"(컴시간 {info['컴시간강의실'] or '없음'})")
    lines.insert(len(lines) - diff if diff else len(lines),
                 f"전체 {total}강좌 중 **{diff}강좌**의 강의실이 다릅니다.\n")
    lines.append("")

    lines.append("## 수업이 배정되지 않은 교사\n")
    none = [n for n in roster if not subj[n]]
    lines.append(', '.join(none) if none else '없음')
    return '\n'.join(lines)


# ────────────────────────────────────────────────── 실행
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--기초시간표', required=True)
    ap.add_argument('--실제강의실', required=True)
    ap.add_argument('--컴시간강의실', required=True)
    ap.add_argument('--명렬표', required=True)
    ap.add_argument('--out', default='data')
    ap.add_argument('--보정', default='data/corrections.json',
                    help='원본 파일의 오류를 바로잡는 표 (없으면 건너뜀)')
    a = ap.parse_args()

    import openpyxl
    wb = openpyxl.load_workbook(getattr(a, '명렬표'), data_only=True)
    ws = wb.worksheets[0]
    roster = []
    for r in ws.iter_rows(values_only=True):
        c = [('' if x is None else str(x).strip()) for x in r]
        if len(c) >= 2 and c[1]:
            roster.append(c[1])
    print(f"명렬표 {len(roster)}명")

    lessons, periods, warn = parse_base(getattr(a, '기초시간표'), set(roster))
    print(f"기초시간표 {len(lessons)}칸, 교시 {len(periods)}개")
    for w in warn[:10]:
        print("  ⚠", w)

    electives = parse_electives(getattr(a, '실제강의실'), getattr(a, '컴시간강의실'))
    print(f"선택과목 학년: {list(electives)}")

    corr = {}
    cpath = getattr(a, '보정')
    if cpath and os.path.exists(cpath):
        corr = json.load(open(cpath, encoding='utf-8'))
        lessons, electives, clog = apply_corrections(lessons, electives, corr)
        print(f"보정 적용 ({cpath})")
        for c in clog:
            print("  ·", c)

    tmap, subj, notes = build_teacher_map(roster, lessons)
    print(f"교사 매핑 {len(tmap)}건")
    for n in notes:
        print("  ·", n)

    os.makedirs(a.out, exist_ok=True)
    classes = defaultdict(set)
    for l in lessons:
        classes[str(l['g'])].add(l['c'])

    json.dump({
        "학기": "2026학년도 2학기",
        "교시": [{"교시": p, "시작": s, "종료": add_minutes(s, PERIOD_MINUTES)}
                 for p, s in sorted(periods.items())],
        "학급": {g: sorted(v) for g, v in sorted(classes.items())},
        "수업": lessons,
    }, open(f"{a.out}/base-timetable.json", 'w'), ensure_ascii=False, indent=1)

    json.dump(electives, open(f"{a.out}/electives.json", 'w'), ensure_ascii=False, indent=1)

    json.dump({
        "_설명": "컴시간 마스킹 이름 -> 실명. build_data.py 가 기초시간표의 담당 과목을 근거로 만듭니다.",
        "map": tmap,
    }, open(f"{a.out}/teacher-map.json", 'w'), ensure_ascii=False, indent=1)

    with open(f"{a.out}/교사명렬표.csv", 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['번호', '이름', '과목', '주간수업수'])
        for i, nm in enumerate(roster, 1):
            ss = sorted(subj[nm], key=lambda s: -subj[nm][s])
            w.writerow([i, nm, ', '.join(ss), sum(subj[nm].values())])

    open(f"{a.out}/검증리포트.md", 'w', encoding='utf-8').write(
        f"# 원본 파일 검증 리포트\n\n{validate(lessons, electives, subj, roster)}\n")

    print(f"\n완료 -> {a.out}/ 에 5개 파일 생성")


if __name__ == '__main__':
    main()
