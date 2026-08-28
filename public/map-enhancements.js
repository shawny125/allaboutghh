(() => {
  'use strict';

  const search = document.querySelector('#search');
  const results = document.querySelector('#results');
  const app = document.querySelector('.map-app');
  const panel = document.querySelector('#teacherPanel');
  const closeButton = document.querySelector('#teacherClose');
  const homeButton = document.querySelector('#home');

  let teachers = [];
  let resultTimer = null;

  search.placeholder = '교실·시설·선생님 이름 검색';

  function closeTeacherPanel() {
    panel.classList.remove('show');
    app.classList.remove('teacher-open');
  }

  function moveMapTo(roomName, restoreText) {
    if (!roomName) return false;

    search.value = roomName;
    search.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
    }));

    window.setTimeout(() => {
      search.value = restoreText;
    }, 0);

    return true;
  }

  function showTeacher(teacher) {
    const office = teacher.교무실;
    const mapTarget = office;

    document.querySelector('#teacherName').textContent = `${teacher.이름} 선생님`;
    document.querySelector('#teacherSubjects').textContent = teacher.과목?.length
      ? `담당 과목 · ${teacher.과목.join(' · ')}`
      : '담당 과목 정보 없음';
    document.querySelector('#teacherOffice').textContent = office || '교무실 위치 등록 필요';

    if (office) {
      document.querySelector('#teacherNote').textContent =
        '평소 근무하는 교무실을 지도에 표시했습니다.';
    } else {
      document.querySelector('#teacherNote').textContent =
        '담당 과목은 시간표에서 확인했지만 소속 교무실 정보는 아직 등록되지 않았습니다.';
    }

    search.value = teacher.이름;
    results.style.display = 'none';
    panel.classList.add('show');
    app.classList.add('teacher-open');

    if (mapTarget) moveMapTo(mapTarget, teacher.이름);
  }

  function appendTeacherResults() {
    const keyword = search.value.trim().toLowerCase();
    if (!keyword) return;

    const matches = teachers
      .filter((teacher) => `${teacher.이름} ${(teacher.과목 || []).join(' ')}`
        .toLowerCase().includes(keyword))
      .slice(0, 6);

    matches.forEach((teacher) => {
      const button = document.createElement('button');
      button.className = 'result teacher-result';

      const name = document.createElement('b');
      name.textContent = `${teacher.이름} 선생님`;

      const description = document.createElement('small');
      const subjects = teacher.과목?.length ? teacher.과목.join(' · ') : '담당 과목 미등록';
      const where = teacher.지금수업?.학급 || teacher.교무실 || '교무실 위치 등록 필요';
      description.textContent = `${subjects} · ${where}`;

      button.append(name, description);
      button.addEventListener('click', () => showTeacher(teacher));
      results.appendChild(button);
    });

    if (matches.length) results.style.display = 'block';
  }

  search.addEventListener('input', () => {
    window.clearTimeout(resultTimer);
    resultTimer = window.setTimeout(appendTeacherResults, 0);
  });

  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const keyword = search.value.trim().toLowerCase();
    const teacher = teachers.find((item) => item.이름.toLowerCase().includes(keyword));
    if (teacher) {
      event.preventDefault();
      window.setTimeout(() => showTeacher(teacher), 0);
    }
  });

  closeButton.addEventListener('click', closeTeacherPanel);
  homeButton.addEventListener('click', closeTeacherPanel);

  fetch('/api/teachers?includeLocations=1')
    .then((response) => {
      if (!response.ok) throw new Error(`교사 정보 응답 오류 (${response.status})`);
      return response.json();
    })
    .then((data) => {
      teachers = Array.isArray(data.교사) ? data.교사 : [];
    })
    .catch((error) => {
      console.warn('선생님 검색 정보를 불러오지 못했습니다.', error);
    });
})();
