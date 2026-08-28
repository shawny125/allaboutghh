#!/usr/bin/env node
/**
 * 교사 실명 매핑표 생성기
 *
 *  컴시간이 주는 마스킹 이름(예: 이서*)과 학교 교직원 명부를 대조해서
 *  data/teacher-map.json 을 만들어 줍니다.
 *
 * 사용법
 *   1) 명부를 CSV 로 준비합니다. 첫 줄은 머리글이고, 이름과 과목 열이 있으면 됩니다.
 *        이름,과목
 *        이서연,통합사회
 *        김민준,수학
 *
 *   2) node tools/build-teacher-map.mjs data/명부.csv
 *      - 한 명으로 확정되는 교사는 data/teacher-map.json 에 바로 기록됩니다.
 *      - 후보가 여럿이거나 못 찾은 교사는 data/teacher-map.review.csv 로 빠집니다.
 *
 *   3) data/teacher-map.review.csv 의 '확정이름' 칸을 채운 뒤
 *      node tools/build-teacher-map.mjs --merge-review
 *      로 합치면 끝입니다.
 *
 * 이 스크립트는 컴시간에 접속하므로 학교 네트워크나 일반 인터넷 환경에서 실행하세요.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const MAP_PATH = path.join(DATA, 'teacher-map.json');
const REVIEW_PATH = path.join(DATA, 'teacher-map.review.csv');

const config = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8'));

// ------------------------------------------------------------------ CSV
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;

  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

function toCsv(rows) {
  return rows.map((r) => r.map((c) => {
    const s = String(c == null ? '' : c);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n') + '\n';
}

const NAME_KEYS = ['이름', '성명', '교사명', '교원명', 'name'];
const SUBJECT_KEYS = ['과목', '담당과목', '교과', '교과목', 'subject'];

function readRoster(csvPath) {
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  if (!rows.length) throw new Error('명부 CSV 가 비어 있습니다.');
  const header = rows[0].map((h) => String(h).trim());
  const nameIdx = header.findIndex((h) => NAME_KEYS.includes(h));
  const subjIdx = header.findIndex((h) => SUBJECT_KEYS.includes(h));
  if (nameIdx < 0) {
    throw new Error(`이름 열을 찾지 못했습니다. 머리글에 ${NAME_KEYS.join(' / ')} 중 하나가 있어야 합니다. (현재: ${header.join(', ')})`);
  }
  return rows.slice(1).map((r) => ({
    name: String(r[nameIdx] || '').trim(),
    subject: subjIdx >= 0 ? String(r[subjIdx] || '').trim() : '',
  })).filter((p) => p.name);
}

// ------------------------------------------------------- 마스킹 이름 대조
/** '이서*' 와 '이서연' 이 같은 사람일 수 있는지 (글자수 + 가려지지 않은 글자) */
function matchesMask(mask, realName) {
  if (mask.length !== realName.length) return false;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] === '*') continue;
    if (mask[i] !== realName[i]) return false;
  }
  return true;
}

/** 명부의 과목과 컴시간 과목명이 얼마나 비슷한지 (0~2) */
function subjectScore(rosterSubject, comciSubjects) {
  if (!rosterSubject) return 0;
  const a = rosterSubject.replace(/\s/g, '');
  let best = 0;
  for (const raw of comciSubjects) {
    const b = String(raw).replace(/\s/g, '');
    if (!b) continue;
    if (a === b) return 2;
    if (a.includes(b) || b.includes(a)) { best = Math.max(best, 2); continue; }
    // 두 글자 이상 겹치면 관련 과목으로 본다 (예: 사회 <-> 통합사회)
    for (let i = 0; i < a.length - 1; i += 1) {
      if (b.includes(a.slice(i, i + 2))) { best = Math.max(best, 1); break; }
    }
  }
  return best;
}

// ------------------------------------------------------------ 컴시간 조회
async function fetchMaskedTeachers() {
  const Timetable = require('comcigan-parser');
  const inst = new Timetable();
  await inst.init({ maxGrade: Number(config.maxGrade) || 3 });

  let school = null;
  const results = (await inst.search(config.schoolName).catch(() => [])) || [];
  const hint = Number(config.schoolCodeHint) || null;
  school = (hint && results.find((s) => Number(s.code) === hint))
    || results.find((s) => String(s.name).trim() === String(config.schoolName).trim())
    || results[0]
    || (hint ? { name: config.schoolName, code: hint } : null);
  if (!school) throw new Error(`학교를 찾지 못했습니다: ${config.schoolName}`);

  console.log(`학교 연결: ${school.name} (코드 ${school.code})`);
  await inst.setSchool(Number(school.code));
  const grid = await inst.getTimetable();

  const found = new Map();   // 마스킹명 -> { subjects:Set, count, slots:Map, clashes }
  for (const g of Object.keys(grid || {})) {
    for (const c of Object.keys(grid[g] || {})) {
      const days = grid[g][c];
      if (!Array.isArray(days)) continue;
      days.forEach((slots, dayIdx) => {
        if (!Array.isArray(slots)) return;
        slots.forEach((cell, periodIdx) => {
          if (!cell) return;
          const t = String(cell.teacher || '').trim();
          const s = String(cell.subject || '').trim();
          if (!t || !s) return;
          if (!found.has(t)) found.set(t, { subjects: new Set(), count: 0, slots: new Map(), clashes: 0 });
          const e = found.get(t);
          e.subjects.add(s);
          e.count += 1;
          // 한 사람이 같은 시간에 두 곳에서 수업할 수는 없다.
          // 중복이 잡히면 이 마스킹 이름 뒤에 두 명 이상이 있다는 확실한 증거다.
          const key = `${Number.isFinite(cell.weekday) ? cell.weekday : dayIdx}-${Number(cell.classTime) || periodIdx + 1}`;
          if (e.slots.has(key)) e.clashes += 1;
          else e.slots.set(key, true);
        });
      });
    }
  }
  return found;
}

// ------------------------------------------------------------------ 실행
function loadMapFile() {
  try {
    const j = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch { return {}; }
}

function saveMapFile(map, extra) {
  const base = loadMapFile();
  const out = {
    _설명: base._설명 || '컴시간의 마스킹된 교사명을 실명으로 바꾸는 표입니다.',
    _사용법: base._사용법 || [
      '일반: "이서*": "이서연"',
      '동명이인: "이서*|통합사회": "이서연" 처럼 과목을 붙여 구분',
      '표시하지 않을 교사: "김민*": null',
    ],
    _갱신: new Date().toISOString(),
    ...(extra || {}),
    map,
  };
  fs.writeFileSync(MAP_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
}

async function main() {
  const args = process.argv.slice(2);

  // ---- 검토 파일 합치기
  if (args.includes('--merge-review')) {
    if (!fs.existsSync(REVIEW_PATH)) throw new Error(`검토 파일이 없습니다: ${REVIEW_PATH}`);
    const rows = parseCsv(fs.readFileSync(REVIEW_PATH, 'utf8'));
    const header = rows[0].map((h) => h.trim());
    const mi = header.indexOf('마스킹명');
    const si = header.indexOf('과목');
    const ci = header.indexOf('확정이름');
    if (mi < 0 || ci < 0) throw new Error('검토 파일에 마스킹명 / 확정이름 열이 있어야 합니다.');

    const map = loadMapFile().map || {};
    let merged = 0;
    for (const r of rows.slice(1)) {
      const mask = String(r[mi] || '').trim();
      const real = String(r[ci] || '').trim();
      if (!mask || !real) continue;
      const subject = si >= 0 ? String(r[si] || '').trim() : '';
      // 같은 마스킹명이 여러 줄이면 과목까지 붙여 구분
      const dupe = rows.slice(1).filter((x) => String(x[mi] || '').trim() === mask).length > 1;
      map[dupe && subject ? `${mask}|${subject.split(',')[0].trim()}` : mask] = real;
      merged += 1;
    }
    saveMapFile(map);
    console.log(`검토 결과 ${merged}건을 합쳤습니다 -> ${MAP_PATH}`);
    return;
  }

  // ---- 명부 대조
  const rosterPath = args.find((a) => !a.startsWith('--'));
  if (!rosterPath) {
    console.log('사용법: node tools/build-teacher-map.mjs <명부.csv>');
    console.log('        node tools/build-teacher-map.mjs --merge-review');
    process.exit(1);
  }
  const roster = readRoster(path.resolve(rosterPath));
  console.log(`명부 ${roster.length}명 읽음`);

  const masked = await fetchMaskedTeachers();
  console.log(`컴시간에서 교사 ${masked.size}명 확인`);

  const map = loadMapFile().map || {};
  const review = [['마스킹명', '과목', '주간수업수', '후보', '판단', '확정이름']];
  let auto = 0;

  const maskEntries = [...masked.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ko'));
  // 과목이 여럿이면 과목마다 한 줄씩 뽑아 준다.
  // 마스킹 이름 하나에 두 교사가 묶인 경우, 과목별로 사람을 지정할 수 있어야 하기 때문.
  const toReview = (mask, info, candidates, note) => {
    const subjects = [...info.subjects];
    const cand = candidates.map((c) => `${c.name}(${c.subject || '과목미상'})`).join(' / ') || '후보 없음';
    const rows = subjects.length > 1 ? subjects : [subjects.join(', ')];
    rows.forEach((sj) => review.push([mask, sj, info.count, cand, note, '']));
  };

  for (const [mask, info] of maskEntries) {
    const subjects = [...info.subjects];
    const candidates = roster.filter((p) => matchesMask(mask, p.name));

    if (!candidates.length) {
      toReview(mask, info, candidates, '명부에서 일치하는 이름을 찾지 못함');
      continue;
    }

    // 같은 시간에 두 곳 수업 = 이 이름 뒤에 두 명 이상. 자동 확정하지 않는다.
    if (info.clashes > 0) {
      toReview(mask, info, candidates, `같은 시간 중복 ${info.clashes}건 — 두 명 이상 확실`);
      continue;
    }

    // 후보가 하나뿐이면 그대로 확정
    if (candidates.length === 1) {
      map[mask] = candidates[0].name;
      auto += 1;
      continue;
    }

    // 후보가 여럿이면 과목별로 누구 것인지 따져 본다
    const attribution = subjects.map((sj) => {
      const owners = candidates.filter((c) => subjectScore(c.subject, [sj]) >= 1);
      return { sj, owners };
    });

    if (attribution.some((a) => a.owners.length !== 1)) {
      toReview(mask, info, candidates, '과목만으로는 누구인지 가릴 수 없음');
      continue;
    }

    const names = new Set(attribution.map((a) => a.owners[0].name));
    if (names.size === 1) {
      map[mask] = [...names][0];          // 모든 과목이 한 사람 것 -> 통째로 확정
    } else {
      // 과목마다 주인이 다르다 -> 과목을 붙인 키로만 기록 (통짜 키는 만들지 않는다)
      attribution.forEach((a) => { map[`${mask}|${a.sj}`] = a.owners[0].name; });
    }
    auto += 1;
  }

  saveMapFile(map, { _자동확정: auto, _검토필요: review.length - 1 });
  fs.writeFileSync(REVIEW_PATH, toCsv(review), 'utf8');

  console.log('');
  console.log(`자동 확정  : ${auto}명  -> ${path.relative(ROOT, MAP_PATH)}`);
  console.log(`검토 필요  : ${review.length - 1}명 -> ${path.relative(ROOT, REVIEW_PATH)}`);
  if (review.length > 1) {
    console.log('');
    console.log('검토 파일의 [확정이름] 칸을 채운 뒤 아래 명령으로 합치세요.');
    console.log('  node tools/build-teacher-map.mjs --merge-review');
  }
}

// 직접 실행할 때만 동작 (다른 파일에서 불러 쓸 때는 함수만 노출)
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((err) => {
    console.error('실패:', err.message);
    process.exit(1);
  });
}

export { parseCsv, toCsv, readRoster, matchesMask, subjectScore, main };
