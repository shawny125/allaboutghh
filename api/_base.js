'use strict';

/**
 * 학교 원본 파일에서 만든 기초 데이터.
 *  - 기초시간표: 컴시간이 안 될 때의 대체 시간표이자, 이동수업 블록의 기준
 *  - 선택과목: 블록 배치와 '실제' 강의실 (컴시간에 찍힌 강의실과 다름)
 */

const base = require('../data/base-timetable.json');
const electives = require('../data/electives.json');

const key = (g, c, d, p) => `${g}-${c}-${d}-${p}`;

// (학년-반-요일-교시) -> 블록 문자
const BLOCK = new Map();
// (학년-반-요일-교시) -> 기초시간표 수업
const BASE = new Map();
// 컴시간에는 비어 있지만 실제로는 있는 수업 (창체 등)
const FIXED = new Map();

base.수업.forEach((l) => {
  const k = key(l.g, l.c, l.d, l.p);
  if (l.block) BLOCK.set(k, l.block);
  else {
    BASE.set(k, l);
    if (l.고정) FIXED.set(k, l);
  }
});

const PERIODS = (base.교시 || []).map((p) => ({
  no: p.교시, start: p.시작, end: p.종료,
  startMin: toMin(p.시작), endMin: toMin(p.종료),
}));

function toMin(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 이 학년에 선택과목 이동수업이 있는가 */
function hasElectives(grade) {
  return Boolean(electives[String(grade)]);
}

/** 블록 + 학생이 고른 과목 -> 실제 강의실 */
function courseInfo(grade, block, subject) {
  const g = electives[String(grade)];
  if (!g || !block) return null;
  const c = (g.강좌 || {})[block] || {};
  if (!subject) return null;
  const hit = c[subject];
  if (!hit) return null;
  return {
    과목: subject,
    강의실: hit.강의실,
    컴시간강의실: hit.컴시간강의실,
    강의실다름: hit.다름,
  };
}

/** 특정 블록에서 고를 수 있는 과목 목록 */
function coursesOfBlock(grade, block) {
  const g = electives[String(grade)];
  if (!g) return [];
  return Object.keys((g.강좌 || {})[block] || {}).sort((a, b) => a.localeCompare(b, 'ko'));
}

/**
 * 컴시간 수업 목록에 이동수업 블록 정보를 덧붙이고,
 * 컴시간에 빠져 있는 블록 칸은 기초시간표 기준으로 채워 넣는다.
 */
function attachBlocks(lessons) {
  const seen = new Set();
  const out = lessons.map((l) => {
    const k = key(l.grade, l.class, l.day, l.period);
    seen.add(k);
    const b = BLOCK.get(k);
    if (!b) return l;
    return { ...l, block: b, 이동수업: true, 컴시간과목: l.subject, 컴시간교사: l.teacher };
  });

  // 컴시간이 비워 둔 이동수업 칸 보충
  BLOCK.forEach((b, k) => {
    if (seen.has(k)) return;
    const [g, c, d, p] = k.split('-').map(Number);
    out.push({
      grade: g, class: c, day: d, period: p,
      subject: '', teacher: '', teacherMasked: '', teacherResolved: true,
      block: b, 이동수업: true,
    });
  });

  // 컴시간이 비워 둔 고정 수업(창체 등) 보충
  FIXED.forEach((l, k) => {
    if (seen.has(k)) return;
    out.push({
      grade: l.g, class: l.c, day: l.d, period: l.p,
      subject: l.subject, teacher: '', teacherMasked: '', teacherResolved: true,
      고정: true,
    });
  });
  return out;
}

/** 컴시간을 못 쓸 때 쓰는 기초시간표 기반 payload */
function basePayload() {
  const lessons = [];
  const classesByGrade = {};
  base.수업.forEach((l) => {
    if (!classesByGrade[l.g]) classesByGrade[l.g] = [];
    if (!classesByGrade[l.g].includes(l.c)) classesByGrade[l.g].push(l.c);
    if (l.block) {
      lessons.push({ grade: l.g, class: l.c, day: l.d, period: l.p,
        subject: '', teacher: '', teacherMasked: '', teacherResolved: true,
        block: l.block, 이동수업: true });
    } else {
      lessons.push({ grade: l.g, class: l.c, day: l.d, period: l.p,
        subject: l.subject, teacher: l.teacher || '', teacherMasked: '',
        teacherResolved: Boolean(l.teacher), ...(l.고정 ? { 고정: true } : {}) });
    }
  });
  Object.keys(classesByGrade).forEach((g) => classesByGrade[g].sort((a, b) => a - b));

  return {
    school: { name: '인천공항고등학교', code: null, matchedBy: 'base' },
    fetchedAt: new Date().toISOString(),
    periods: PERIODS,
    grades: Object.keys(classesByGrade).map(Number).sort((a, b) => a - b),
    classesByGrade,
    lessons,
    source: '기초시간표',
  };
}

module.exports = {
  base, electives, PERIODS,
  hasElectives, courseInfo, coursesOfBlock, attachBlocks, basePayload,
  blockAt: (g, c, d, p) => BLOCK.get(key(g, c, d, p)) || null,
};
