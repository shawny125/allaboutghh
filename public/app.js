/* 올어바웃 인천공항고 — 화면 로직 */
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const API = (params.get('api') || '/api').replace(/\/$/, '');
  const LS = { grade: 'agh.grade', klass: 'agh.class', tab: 'agh.tab', pick: 'agh.pick' };

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const state = {
    meta: null,        // 교시/학년/반/현재
    periods: [],       // [{no, start, end, s, e}]  s,e = 분 단위
    classData: null,
    teachers: [],
    teacherFilter: 'all',
    electives: null,     // /api/electives 응답
    pick: {},            // 내가 고른 선택과목  { A: '데이터과학', ... }
  };

  // ───────────────────────────────────────────── 이동수업(선택과목)
  function curGrade() { return Number(($('#gradeSel') || {}).value) || null; }

  function loadPick(grade) {
    try { state.pick = JSON.parse(localStorage.getItem(`${LS.pick}.${grade}`) || '{}'); }
    catch { state.pick = {}; }
  }
  function savePick(grade) {
    try { localStorage.setItem(`${LS.pick}.${grade}`, JSON.stringify(state.pick)); } catch { /* 저장 실패는 무시 */ }
  }

  /** 블록 -> 내가 고른 과목과 실제 강의실 */
  function moveInfo(grade, block) {
    const e = state.electives && state.electives[String(grade)];
    if (!e || !block) return null;
    const subject = state.pick[block];
    if (!subject) return { block, subject: null, room: null };
    const c = (e.강좌 || {})[block] || {};
    const hit = c[subject];
    return { block, subject, room: hit ? hit.강의실 : null, diff: hit ? hit.다름 : false };
  }

  function renderElectivePicker() {
    const card = $('#electiveCard');
    const box = $('#electivePicker');
    const grade = curGrade();
    const e = state.electives && state.electives[String(grade)];
    if (!e) { card.hidden = true; return; }

    card.hidden = false;
    loadPick(grade);
    box.textContent = '';
    ['A', 'B', 'C', 'D', 'E'].forEach((blk) => {
      const subs = Object.keys((e.강좌 || {})[blk] || {}).sort((a, b) => a.localeCompare(b, 'ko'));
      if (!subs.length) return;
      const row = el('div', 'erow');
      row.appendChild(el('div', 'blk', blk));
      const sel = document.createElement('select');
      sel.appendChild(new Option('선택 안 함', ''));
      subs.forEach((s) => {
        const info = (e.강좌[blk] || {})[s] || {};
        sel.appendChild(new Option(`${s} — ${info.강의실 || '장소 미정'}`, s));
      });
      sel.value = state.pick[blk] || '';
      sel.onchange = () => {
        if (sel.value) state.pick[blk] = sel.value; else delete state.pick[blk];
        savePick(grade);
        const g = $('#gradeSel').value, c = $('#classSel').value;
        if (g && c) loadClass(g, c);
      };
      row.appendChild(sel);
      box.appendChild(row);
    });
  }

  // ------------------------------------------------------------- 시간 계산
  const WD = ['월', '화', '수', '목', '금', '토', '일'];

  /** '2026년 8월 27일 목요일' */
  function todayLine() {
    const p = new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
    }).format(new Date());
    return p;
  }

  function kstNow() {
    const p = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit',
      second: '2-digit', weekday: 'short', hour12: false,
    }).formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
    const map = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
    return {
      weekday: map[p.weekday],
      seconds: (Number(p.hour) % 24) * 3600 + Number(p.minute) * 60 + Number(p.second),
    };
  }

  const toMin = (hhmm) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };

  /** 지금 상태를 초 단위로 계산 */
  function nowInfo() {
    const t = kstNow();
    const school = t.weekday <= 4;
    const ps = state.periods;
    if (!school || !ps.length) {
      return { weekday: t.weekday, status: school ? 'after' : 'weekend' };
    }
    for (let i = 0; i < ps.length; i += 1) {
      const p = ps[i];
      if (t.seconds >= p.s * 60 && t.seconds < p.e * 60) {
        return {
          weekday: t.weekday, status: 'in', period: p.no,
          next: ps[i + 1] ? ps[i + 1].no : null,
        };
      }
      if (t.seconds < p.s * 60) {
        return {
          weekday: t.weekday, status: i === 0 ? 'before' : 'break',
          next: p.no,
        };
      }
    }
    return { weekday: t.weekday, status: 'after' };
  }

  // ------------------------------------------------------------------ 통신
  async function api(path) {
    const r = await fetch(API + path, { headers: { Accept: 'application/json' } });
    const j = await r.json().catch(() => ({ ok: false, error: '응답을 읽지 못했습니다.' }));
    if (!r.ok && j.ok !== true) throw new Error(j.error || `요청 실패 (${r.status})`);
    return j;
  }

  function banner(msg, kind) {
    const b = $('#banner');
    if (!msg) { b.hidden = true; return; }
    b.hidden = false;
    b.className = 'banner' + (kind === 'err' ? ' err' : '');
    b.textContent = msg;
  }

  // -------------------------------------------------------------- 지금 화면
  function renderNow() {
    const n = nowInfo();
    const label = $('#nowLabel');
    const big = $('#nowBig');
    const sub = $('#nowSub');
    const time = $('#nowTime');

    const periodOf = (no) => state.periods.find((p) => p.no === no);

    if (n.status === 'weekend') {
      label.textContent = WD[n.weekday] + '요일';
      big.textContent = '휴일';
      sub.textContent = '오늘은 수업이 없습니다.';
      time.textContent = '';
    } else if (n.status === 'before') {
      const p = periodOf(n.next);
      label.textContent = '일과 시작 전';
      big.textContent = `${n.next}교시부터`;
      sub.textContent = firstSubjectLine(n.next);
      time.textContent = p ? `${p.start} 시작` : '';
    } else if (n.status === 'in') {
      const p = periodOf(n.period);
      label.textContent = '지금은';
      big.textContent = `${n.period}교시`;
      sub.textContent = currentSubjectLine(n.period);
      time.textContent = p ? `${p.start} – ${p.end}` : '';
    } else if (n.status === 'break') {
      const p = periodOf(n.next);
      label.textContent = '쉬는 시간';
      big.textContent = `다음 ${n.next}교시`;
      sub.textContent = firstSubjectLine(n.next);
      time.textContent = p ? `${p.start} 시작` : '';
    } else {
      label.textContent = WD[n.weekday] + '요일';
      big.textContent = '일과 끝';
      sub.textContent = '오늘 수업이 모두 끝났습니다.';
      time.textContent = '';
    }

    highlightToday(n);
    markTable(n);
  }

  /** 특정 교시의 우리 반 수업 (다음 교시 안내용) */
  function firstSubjectLine(period) {
    const d = state.classData;
    if (!d || !period) return '';
    return lessonLine((d.오늘수업 || []).find((x) => x.교시 === period), d);
  }

  function lessonLine(hit, d) {
    const who = `${d.학급.학년}-${d.학급.반}`;
    if (!hit) return `${who} · 이 시간 수업 없음`;
    if (hit.이동수업) {
      const mi = moveInfo(d.학급.학년, hit.블록);
      if (mi && mi.subject) return `${who} · ${mi.subject}${mi.room ? ' · ' + mi.room : ''}`;
      return `${who} · 이동수업 ${hit.블록}블록`;
    }
    return `${who} · ${hit.과목}${hit.교사 ? ' · ' + hit.교사 : ''}`;
  }

  function currentSubjectLine(period) {
    const d = state.classData;
    if (!d) return '반을 선택하면 지금 수업이 표시됩니다.';
    return lessonLine((d.오늘수업 || []).find((x) => x.교시 === period), d);
  }

  function highlightToday(n) {
    const box = $('#todayList');
    const d = state.classData;
    if (!d) return;
    box.textContent = '';
    const list = d.오늘수업 || [];
    if (!list.length) {
      box.appendChild(el('p', 'spin', n.status === 'weekend' ? '휴일입니다.' : '오늘은 등록된 수업이 없습니다.'));
      return;
    }
    const grade = curGrade();
    list.forEach((x) => {
      const on = n.status === 'in' && n.period === x.교시;
      const row = el('div', 'row' + (on ? ' on' : '')
        + (x.이동수업 ? ' mv' : '') + (x.고정 ? ' fx' : ''));
      row.appendChild(el('span', 'no', x.교시));
      if (x.이동수업) {
        const mi = moveInfo(grade, x.블록);
        row.appendChild(el('span', 'sj', mi && mi.subject ? mi.subject : '이동수업'));
        row.appendChild(el('span', 'badge-mv', `${x.블록}블록`));
        if (mi && mi.room) row.appendChild(el('span', 'rm', mi.room));
      } else {
        row.appendChild(el('span', 'sj', x.과목));
        if (x.교사) row.appendChild(el('span', 'tc', x.교사));
      }
      box.appendChild(row);
    });
  }

  // ------------------------------------------------------------ 학급 시간표
  function buildTable(d, n) {
    const table = $('#classTable');
    table.textContent = '';
    if (!d) return;

    const days = d.주간시간표 || [];
    const maxP = d.최대교시 || 0;

    const thead = el('thead');
    const hr = el('tr');
    hr.appendChild(el('th', 'pn', ''));
    days.forEach((day, i) => {
      const th = el('th', i === n.weekday ? 'today' : null, day.요일);
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = el('tbody');
    for (let p = 1; p <= maxP; p += 1) {
      const tr = el('tr');
      tr.appendChild(el('th', 'pn', p));
      days.forEach((day, i) => {
        const cell = (day.수업 || [])[p - 1];
        const td = el('td');
        if (i === n.weekday) td.classList.add('today');
        if (i === n.weekday && n.status === 'in' && n.period === p) td.classList.add('now');
        if (!cell) { td.classList.add('empty'); td.textContent = '·'; }
        else if (cell.이동수업) {
          td.classList.add('mv');
          const mi = moveInfo(d.학급.학년, cell.블록);
          td.appendChild(el('span', 'sj', mi && mi.subject ? mi.subject : `이동 ${cell.블록}`));
          td.appendChild(el('span', 'tc', mi && mi.subject ? `${cell.블록}블록` : '선택과목'));
          if (mi && mi.room) td.appendChild(el('span', 'rm', mi.room));
        } else {
          if (cell.고정) td.classList.add('fx');
          td.appendChild(el('span', 'sj', cell.과목));
          if (cell.교사) td.appendChild(el('span', 'tc', cell.교사));
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }

  function markTable(n) {
    document.querySelectorAll('#classTable td.now').forEach((td) => td.classList.remove('now'));
    if (n.status !== 'in') return;
    const rows = document.querySelectorAll('#classTable tbody tr');
    const row = rows[n.period - 1];
    if (!row) return;
    const td = row.children[n.weekday + 1];
    if (td) td.classList.add('now');
  }

  async function loadClass(grade, klass) {
    if (!grade || !klass) return;
    localStorage.setItem(LS.grade, grade);
    localStorage.setItem(LS.klass, klass);
    try {
      const d = await api(`/timetable?grade=${grade}&class=${klass}`);
      state.classData = d;
      buildTable(d, nowInfo());
      renderNow();
    } catch (e) {
      banner(`시간표를 불러오지 못했습니다: ${e.message}`, 'err');
    }
  }

  function fillPickers() {
    const g = $('#gradeSel');
    const c = $('#classSel');
    const meta = state.meta;
    g.textContent = '';
    (meta.학년 || []).forEach((x) => g.appendChild(new Option(`${x}학년`, x)));

    const savedG = Number(localStorage.getItem(LS.grade)) || (meta.학년 || [])[0];
    if (savedG) g.value = String(savedG);

    const fillClasses = () => {
      const list = (meta.학년별반 || {})[g.value] || [];
      c.textContent = '';
      list.forEach((x) => c.appendChild(new Option(`${x}반`, x)));
      const savedC = Number(localStorage.getItem(LS.klass));
      if (savedC && list.includes(savedC)) c.value = String(savedC);
    };
    fillClasses();

    g.onchange = () => { fillClasses(); renderElectivePicker(); loadClass(g.value, c.value); };
    c.onchange = () => loadClass(g.value, c.value);
    return { g, c };
  }

  // ---------------------------------------------------------------- 교사
  function renderTeachers() {
    const box = $('#teacherList');
    const q = ($('#teacherSearch').value || '').trim();
    box.textContent = '';

    let list = state.teachers;
    if (state.teacherFilter === 'teaching') list = list.filter((t) => t.상태 === '수업중');
    if (state.teacherFilter === 'free') list = list.filter((t) => t.상태 !== '수업중');
    if (q) {
      list = list.filter((t) => t.이름.includes(q) || (t.과목 || []).some((s) => s.includes(q)));
    }

    if (!list.length) {
      box.appendChild(el('p', 'spin', '해당하는 교사가 없습니다.'));
      return;
    }

    list.forEach((t) => {
      const b = el('button', 'tcard');
      b.type = 'button';
      b.appendChild(el('div', 'av', t.이름.slice(0, 1)));
      const left = el('div');
      left.appendChild(el('div', 'nm', t.이름));
      left.appendChild(el('div', 'sj', (t.과목 || []).slice(0, 3).join(', ')));
      if (!t.실명확인) left.appendChild(el('div', 'mask', '실명 미확인'));
      b.appendChild(left);

      const right = el('div', 'st');
      const teaching = t.상태 === '수업중';
      right.appendChild(el('span', 'pill ' + (teaching ? 'on' : 'off'), t.상태));
      if (teaching && t.지금수업) {
        const more = t.지금수업.동시건수 > 1 ? ` 외 ${t.지금수업.동시건수 - 1}` : '';
        right.appendChild(el('div', 'where', `${t.지금수업.학급} · ${t.지금수업.과목}${more}`));
      } else if (t.다음수업) {
        right.appendChild(el('div', 'where', `다음 ${t.다음수업.교시}교시 ${t.다음수업.학급}`));
      }
      b.appendChild(right);

      b.onclick = () => openTeacher(t.이름);
      box.appendChild(b);
    });
  }

  async function openTeacher(name) {
    const sheet = $('#sheet');
    $('#sheetTitle').textContent = `${name} 선생님`;
    $('#sheetBody').textContent = '';
    $('#sheetBody').appendChild(el('p', 'spin', '불러오는 중…'));
    sheet.hidden = false;

    try {
      const d = await api(`/teachers?name=${encodeURIComponent(name)}`);
      const body = $('#sheetBody');
      body.textContent = '';

      const info = el('p', 'hint',
        `담당 ${(d.교사.과목 || []).join(', ')} · 주 ${d.교사.주간수업수}시간`);
      body.appendChild(info);

      if (d.지금수업) {
        const p = el('p', 'hint');
        p.appendChild(el('span', 'pill on', '지금 수업 중'));
        p.appendChild(document.createTextNode(` ${d.지금수업.학급} · ${d.지금수업.과목}`));
        body.appendChild(p);
      }
      if (d.충돌수) {
        const w = el('p', 'clash-note', d.충돌안내);
        body.appendChild(w);
      }

      const scroll = el('div', 'table-scroll');
      const table = el('table', 'tt');
      const n = nowInfo();
      const days = d.주간시간표 || [];
      const head = el('thead');
      const hr = el('tr');
      hr.appendChild(el('th', 'pn', ''));
      days.forEach((day, i) => hr.appendChild(el('th', i === n.weekday ? 'today' : null, day.요일)));
      head.appendChild(hr);
      table.appendChild(head);

      const tb = el('tbody');
      for (let p = 1; p <= (d.최대교시 || 0); p += 1) {
        const tr = el('tr');
        tr.appendChild(el('th', 'pn', p));
        days.forEach((day, i) => {
          const cell = (day.수업 || [])[p - 1];
          const td = el('td');
          if (i === n.weekday) td.classList.add('today');
          if (i === n.weekday && n.status === 'in' && n.period === p) td.classList.add('now');
          if (!cell) { td.classList.add('empty'); td.textContent = '·'; }
          else {
            (cell.목록 || []).forEach((x, k) => {
              td.appendChild(el('span', k === 0 ? 'sj' : 'tc', x.학급));
              td.appendChild(el('span', 'tc', x.과목));
            });
            if (cell.충돌) td.classList.add('clash');
          }
          tr.appendChild(td);
        });
        tb.appendChild(tr);
      }
      table.appendChild(tb);
      scroll.appendChild(table);
      body.appendChild(scroll);
    } catch (e) {
      $('#sheetBody').textContent = `불러오지 못했습니다: ${e.message}`;
    }
  }



  // ───────────────────────────────────────────── 급식
  function renderMeal(d) {
    const box = $('#mealBox');
    const dateEl = $('#mealDate');
    box.textContent = '';

    if (d && d.날짜) {
      const y = d.날짜.slice(0, 4), m = Number(d.날짜.slice(4, 6)), dd = Number(d.날짜.slice(6, 8));
      dateEl.textContent = `${m}월 ${dd}일`;
    }

    const list = (d && d.급식) || [];
    if (!list.length) {
      box.appendChild(el('p', 'none', (d && d.안내) || '오늘은 급식 정보가 없습니다.'));
      return;
    }

    list.forEach((meal) => {
      const g = el('div', 'mgroup');
      const head = el('div', 'mhead');
      head.appendChild(el('div', 'mname', meal.구분));
      if (meal.칼로리) head.appendChild(el('div', 'mcal', meal.칼로리));
      g.appendChild(head);

      const dishes = el('div', 'dishes');
      meal.메뉴.forEach((x) => {
        const chip = el('span', 'dish', x.이름);
        if (x.알레르기 && x.알레르기.length) {
          chip.appendChild(el('sup', null, x.알레르기.join('.')));
        }
        dishes.appendChild(chip);
      });
      g.appendChild(dishes);
      box.appendChild(g);
    });

    const table = (d && d.알레르기표) || {};
    const keys = Object.keys(table);
    if (keys.length) {
      box.appendChild(el('p', 'legend',
        '알레르기 · ' + keys.map((k) => `${k} ${table[k]}`).join(' / ')));
    }
  }

  // ───────────────────────────────────────────── 바로가기
  const ICONS = {
    school: '<path d="M12 3 2 8l10 5 10-5-10-5Z"/><path d="M6 10.5V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-5.5"/>',
    wifi: '<path d="M2 8.8a16 16 0 0 1 20 0"/><path d="M5 12.3a11 11 0 0 1 14 0"/><path d="M8.5 15.8a6 6 0 0 1 7 0"/><circle cx="12" cy="19.5" r="1.2" fill="currentColor" stroke="none"/>',
    link: '<path d="M10 13a4 4 0 0 0 5.7 0l3-3a4 4 0 1 0-5.7-5.7L11.5 6"/><path d="M14 11a4 4 0 0 0-5.7 0l-3 3A4 4 0 1 0 11 19.7L12.5 18"/>',
    map: '<path d="m9 4-6 2.5v14L9 18l6 2.5 6-2.5V4l-6 2.5L9 4Z"/><path d="M9 4v14M15 6.5v14"/>',
  };

  function iconEl(name) {
    const wrap = el('div', 'ic');
    wrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.link}</svg>`;
    return wrap;
  }

  /** 클립보드 복사 — https 가 아니면 예전 방식으로 대체 */
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* 아래 대체 방법으로 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  }

  function renderLinks(list) {
    const box = $('#linkList');
    box.textContent = '';
    (list || []).forEach((item) => {
      const isLink = item.종류 === 'link';
      const node = document.createElement(isLink ? 'a' : 'button');
      node.className = 'lrow' + (item.종류 === 'page' ? ' soon' : '');
      if (isLink) {
        node.href = item.url;
        node.target = '_blank';
        node.rel = 'noopener noreferrer';
      } else {
        node.type = 'button';
      }

      node.appendChild(iconEl(item.아이콘));
      const tx = el('div', 'tx');
      tx.appendChild(el('div', 'ti', item.제목));
      const de = el('div', 'de', item.종류 === 'copy' ? item.value : (item.설명 || ''));
      tx.appendChild(de);
      node.appendChild(tx);
      node.appendChild(el('div', 'go', item.종류 === 'copy' ? '복사' : '\u203A'));

      if (item.종류 === 'copy') {
        node.onclick = async () => {
          const ok = await copyText(item.value);
          const go = node.querySelector('.go');
          node.classList.add('copied');
          de.textContent = ok ? '복사했습니다' : '복사에 실패했어요. 길게 눌러 직접 복사해 주세요.';
          go.textContent = ok ? '완료' : '';
          setTimeout(() => {
            node.classList.remove('copied');
            de.textContent = item.value;
            go.textContent = '복사';
          }, 1800);
        };
      } else if (item.종류 === 'page') {
        node.onclick = () => { location.href = item.url; };
      }
      box.appendChild(node);
    });
  }

  // ----------------------------------------------------------------- 탭
  function setTab(name) {
    ['now', 'class', 'teacher'].forEach((t) => {
      $(`#panel-${t}`).hidden = t !== name;
    });
    document.querySelectorAll('.tab').forEach((b) => {
      b.classList.toggle('is-on', b.dataset.tab === name);
    });
    localStorage.setItem(LS.tab, name);
  }

  // ---------------------------------------------------------------- 시작
  async function boot() {
    document.querySelectorAll('.tab').forEach((b) => {
      b.onclick = () => setTab(b.dataset.tab);
    });
    setTab(localStorage.getItem(LS.tab) || 'now');
    $('#pickClass').onclick = () => setTab('class');
    $('#clearPick').onclick = () => {
      state.pick = {};
      savePick(curGrade());
      renderElectivePicker();
      const g = $('#gradeSel').value, c = $('#classSel').value;
      if (g && c) loadClass(g, c);
    };
    $('#sheetClose').onclick = () => { $('#sheet').hidden = true; };
    $('#sheet').onclick = (e) => { if (e.target.id === 'sheet') $('#sheet').hidden = true; };
    $('#teacherSearch').oninput = renderTeachers;
    document.querySelectorAll('.chip').forEach((c) => {
      c.onclick = () => {
        document.querySelectorAll('.chip').forEach((x) => x.classList.remove('is-on'));
        c.classList.add('is-on');
        state.teacherFilter = c.dataset.filter;
        renderTeachers();
      };
    });

    try {
      const meta = await api('/timetable');
      state.meta = meta;
      state.periods = (meta.교시 || []).map((p) => ({
        no: p.교시, start: p.시작, end: p.종료, s: toMin(p.시작), e: toMin(p.종료),
      })).filter((p) => p.s != null && p.e != null);

      $('#schoolLine').textContent = todayLine();
      $('#sourceLine').textContent = `시간표 출처: ${meta.출처 || '컴시간'}`;
      $('#fetchedLine').textContent =
        '마지막 갱신 ' + new Date(meta.조회시각).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });


      try {
        const ev = await api('/electives');
        state.electives = ev.데이터 || null;
      } catch { state.electives = null; }

      const { g, c } = fillPickers();
      loadPick(Number(g.value));
      renderElectivePicker();
      await loadClass(g.value, c.value);
    } catch (e) {
      banner(`시간표 서버에 연결하지 못했습니다: ${e.message}`, 'err');
      $('#schoolLine').textContent = '연결 실패';
    }

    try {
      renderMeal(await api('/meal'));
    } catch {
      renderMeal(null);
    }

    try {
      const lk = await api('/links');
      renderLinks(lk.바로가기);
    } catch {
      $('#linkList').textContent = '';
      $('#linkList').appendChild(el('p', 'spin', '바로가기를 불러오지 못했습니다.'));
    }

    try {
      const t = await api('/teachers');
      state.teachers = t.교사 || [];
      $('#teacherHint').textContent =
        `교사 ${t.교사수}명` + (t.실명미확인 ? ` · 실명 미확인 ${t.실명미확인}명 (명부 매핑 필요)` : '');
      renderTeachers();
    } catch (e) {
      $('#teacherList').textContent = '';
      $('#teacherList').appendChild(el('p', 'spin', `교사 목록을 불러오지 못했습니다: ${e.message}`));
    }

    renderNow();
    setInterval(renderNow, 20000);
    // 10분마다 서버 데이터 갱신 (변경된 시간표 반영)
    setInterval(async () => {
      try {
        const t = await api('/teachers');
        state.teachers = t.교사 || [];
        renderTeachers();
        const g = $('#gradeSel').value, c = $('#classSel').value;
        if (g && c) await loadClass(g, c);
      } catch { /* 조용히 무시하고 다음 주기에 재시도 */ }
    }, 10 * 60 * 1000);
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
