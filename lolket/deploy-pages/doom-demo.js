// ══ 멸망전 체험 모드 (가이드 전용) ══
//   doom?demo=admin|captain|newcap|player|guest&seed=empty|teams|scrims|mine|rejected
//   실제 서버 대신 이 파일의 가짜 데이터로 움직이고, 디스코드에서 일어날 일(포스트 · DM · 스레드)은
//   가이드 페이지에 postMessage 로 알려 줘요. 진짜 디스코드 · DB 에는 아무것도 보내지 않아요.
(function () {
  var q = new URLSearchParams(location.search);
  var ROLE = q.get('demo') || 'admin', SEED = q.get('seed') || 'teams';
  var LANES = ['top', 'jg', 'mid', 'bot', 'sup'];
  var KO = { top: '탑', jg: '정글', mid: '미드', bot: '원딜', sup: '서폿' };
  var EN = { top: 'TOP', jg: 'JGL', mid: 'MID', bot: 'BOT', sup: 'SUP' };
  var clone = function (x) { return JSON.parse(JSON.stringify(x)); };
  var r2 = function (n) { return Math.round((Number(n) || 0) * 100) / 100; };
  var now = Date.now(), H = 3600000, D = 86400000;
  window.confirm = function () { return true; };   // 체험 중에는 확인 창 없이 바로 진행

  // ── 점수표 (화면의 티어 보정 미리보기와 같은 규칙) ──
  var TABLE = [];
  [[0, 199, 40], [200, 399, 42], [400, 699, 44], [700, 999, 46], [1000, 9999, 48]].forEach(function (r) { TABLE.push({ tier: 'MASTER+', minLp: r[0], maxLp: r[1], top: r[2], jg: r[2] + 0.5, mid: r[2] + 1, bot: r[2], sup: r[2] - 1 }); });
  [['DIAMOND', 37], ['EMERALD', 32], ['PLATINUM', 27], ['GOLD', 22]].forEach(function (t) { [1, 2, 3, 4].forEach(function (d) { var b = t[1] - (d - 1); TABLE.push({ tier: t[0], div: d, top: b, jg: b + 0.5, mid: b + 1, bot: b, sup: b - 1 }); }); });
  var HIGH = ['MASTER', 'GRANDMASTER', 'CHALLENGER'], TIERS = ['CHALLENGER', 'GRANDMASTER', 'MASTER', 'DIAMOND', 'EMERALD', 'PLATINUM', 'GOLD', 'SILVER', 'BRONZE', 'IRON'];
  function parseTier(s) {
    s = String(s || '').toUpperCase().trim(); if (!s) return null;
    var p = s.split(/\s+/); if (TIERS.indexOf(p[0]) < 0) return null;
    var DV = { I: 1, II: 2, III: 3, IV: 4 }, m = s.match(/(\d+)\s*LP/);
    return { base: p[0], div: p[1] && DV[p[1]] ? DV[p[1]] : 4, lp: m ? parseInt(m[1], 10) : 0 };
  }
  function scoreOf(tier, l) {
    var ti = parseTier(tier); if (!ti) return null;
    var row = HIGH.indexOf(ti.base) >= 0 ? TABLE.find(function (r) { return r.tier === 'MASTER+' && ti.lp >= r.minLp && ti.lp <= r.maxLp; })
      : (TABLE.find(function (r) { return r.tier === ti.base && r.div === ti.div; }) || TABLE.filter(function (r) { return r.tier === 'GOLD'; }).pop());
    return row ? r2(row[l]) : null;
  }

  // ── 가짜 커뮤니티 멤버 ──
  var NAMES = ['하늘바람', '루나틱', '쿠키몬', '데스노트', '블루문', '레드썬', '은하수', '새벽별', '검은고양이', '붉은여우', '청룡', '백호', '현무', '주작', '태풍의눈',
    '폭풍전야', '미드장인', '정글러버', '원딜왕', '서폿요정', '탑신병자', '칼바람', '칼날비', '달빛기사', '별빛소녀', '초코칩', '바닐라', '민트초코', '라떼', '에스프레소'];
  var TIERLIST = ['MASTER 320LP', 'DIAMOND I', 'DIAMOND II', 'EMERALD I', 'DIAMOND III', 'EMERALD II', 'MASTER 120LP', 'DIAMOND IV', 'EMERALD III', 'PLATINUM I'];
  var POOL = NAMES.map(function (n, i) {
    var dcOn = i % 7 !== 5, tier = TIERLIST[i % TIERLIST.length], sc = {};
    LANES.forEach(function (l) { sc[l] = scoreOf(tier, l); });
    return { did: dcOn ? String(900000 + i) : 'dl:demo' + i, dc: dcOn, name: n, tag: 'KR' + (1 + i % 3), dlPuuid: 'demo' + i, riotPuuid: dcOn ? 'rp' + i : null,
      mainLane: dcOn ? LANES[i % 5] : '', subLanes: [], discordName: dcOn ? n.toLowerCase() : '', tier: tier, src: i % 4 === 0 ? 'temp' : 'peak', scores: sc };
  });
  function P(name) { return POOL.find(function (p) { return p.name === name; }); }
  function mem(p, l) { return { did: p.did, dc: p.dc, name: p.name, tag: p.tag, dlPuuid: p.dlPuuid, tier: p.tier, src: p.src, score: p.scores[l] }; }
  function mkTeam(id, name, color, cap, names, st, extra) {
    var members = {}, tot = 0;
    LANES.forEach(function (l, i) { members[l] = mem(P(names[i]), l); tot += members[l].score || 0; });
    var c = P(cap);
    return Object.assign({ id: id, name: name, color: color, captain: { did: c.did, name: c.name }, members: members, base: r2(tot), bonus: 0, bonusNote: '', memo: '', total: r2(tot), status: st, createdAt: now - 5 * D }, extra || {});
  }

  // ── 시나리오 ──
  var USERS = { admin: { did: '800001', name: '운영자' }, captain: P('하늘바람'), newcap: P('청룡'), player: P('은하수'), guest: P('은하수') };
  var st = { dooms: {}, teams: {}, scrims: {}, logged: ROLE !== 'guest' };
  var ROLES = [{ id: 'r1', name: '팀장', color: 0xE2BE6A }, { id: 'r2', name: '멸망전 참가자', color: 0x5865F2 }, { id: 'r3', name: '운영진', color: 0xE06C75 }];
  var CHANNELS = [{ id: 'c1', name: '스크림-모집' }, { id: 'c2', name: '내전-공지' }], TEXTS = [{ id: 't1', name: '스크림-매칭' }, { id: 't2', name: '일반' }];
  function baseDoom(status) {
    return { id: 'd1', name: '겨울 멸망전', desc: '12월 한 달 동안 진행하는 멸망전이에요.\n팀 합계 점수 200점 이하 · 매주 토요일 본선', startDate: '2026-12-01', endDate: '2026-12-31',
      status: status, entryTerms: '1. 참가비 1만 원을 본선 전날까지 입금해 주세요.\n2. 최종 출전이 확정되면 팀원을 바꿀 수 없어요.\n3. 본선 당일 10분 이상 지각하면 몰수패예요.\n4. 비매너 · 대리 적발 시 실격 처리돼요.', scrimRoleIds: ['r1'], scrimRoleNames: ['팀장'], scrimChannelId: 'c1', scrimChannelName: '스크림-모집', matchChannelId: 't1', matchChannelName: '스크림-매칭', voiceCategoryId: 'k1', voiceCategoryName: '멸망전 팀 음성', scrimVoiceCategoryId: 'k2', scrimVoiceCategoryName: '음성 채널', createdAt: now - 7 * D };
  }
  var T = {};
  function seedTeams(withPending) {
    T.blue = mkTeam('tb', '블루 드래곤', '#4FA8FF', '하늘바람', ['하늘바람', '블루문', '미드장인', '원딜왕', '서폿요정'], 'approved');
    T.red = mkTeam('tr', '레드 피닉스', '#FF6B7A', '루나틱', ['탑신병자', '루나틱', '레드썬', '붉은여우', '별빛소녀'], 'approved');
    T.green = mkTeam('tg', '그린 터틀', '#3CE085', '쿠키몬', ['현무', '새벽별', '쿠키몬', '칼날비', '초코칩'], withPending ? 'pending' : 'approved',
      withPending ? { memo: '정글 새벽별 최고티어가 실제로는 다이아1이에요.\n특수룰로 서폿 +2점 받기로 했어요.' } : {});
    T.purple = mkTeam('tp', '퍼플 레인', '#B07CF0', '데스노트', ['태풍의눈', '데스노트', '달빛기사', '칼바람', '바닐라'], withPending ? 'pending' : 'approved');
    st.teams.d1 = {}; [T.blue, T.red, T.green, T.purple].forEach(function (t) { st.teams.d1[t.id] = t; });
  }
  function scrimOf(id, team, name, startIn, subs, range) {
    var roster = {}, tot = 0;
    LANES.forEach(function (l) { var o = team.members[l], sd = subs && subs[l]; roster[l] = sd ? Object.assign(mem(P(sd), l), { sub: true, orig: o }) : clone(o); tot += roster[l].score || 0; });
    return { id: id, doomId: 'd1', name: name, desc: '3판 2선승 · 토너먼트 드래프트로 진행해요.', note: '정시 시작 · 디스코드 음성 필수', recruitStart: now - D, recruitEnd: now + 2 * D, startAt: now + startIn * D + 12 * H,
      minScore: range[0], maxScore: range[1], teamId: team.id, teamName: team.name, teamColor: team.color, captain: team.captain, roster: roster, base: r2(tot), bonus: 0, total: r2(tot),
      status: 'open', threadId: 'th_' + id, apps: { teams: {}, solo: {} }, createdAt: now - D };
  }
  function teamApp(team, subs) {
    var roster = {}, tot = 0;
    LANES.forEach(function (l) { var o = team.members[l], sd = subs && subs[l]; roster[l] = sd ? Object.assign(mem(P(sd), l), { sub: true, orig: o }) : clone(o); tot += roster[l].score || 0; });
    return { id: team.id, teamId: team.id, teamName: team.name, teamColor: team.color, captain: team.captain, roster: roster, base: r2(tot), bonus: 0, total: r2(tot), at: now - 3 * H };
  }
  function soloApp(name, l) { return Object.assign(mem(P(name), l), { at: now - 2 * H }); }
  if (SEED !== 'empty') {
    st.dooms.d1 = baseDoom(SEED === 'scrims' || SEED === 'mine' ? 'running' : 'open');
    seedTeams(SEED === 'teams');
    if (SEED === 'info') st.dooms.d1.info = {
      schedule: [{ when: '11/26 ~ 12/4', what: '팀 구성 기간' }, { when: '12/4 23:59까지', what: '팀 명단 제출', note: '16팀 선착순 · 계정 인증도 12/4까지 함께 완료' }, { when: '12/5 ~ 12/11 | 12/14 ~ 12/18', what: '스크림 기간' },
        { when: '12/12', what: '16강', main: true }, { when: '12/13', what: '8강', main: true }, { when: '12/19', what: '4강', main: true }, { when: '12/20', what: '결승', main: true }],
      mainTime: '21시', scheduleNote: '경기는 무조건 21시에 시작해요.\n※ 경기 일정은 팀 수에 따라 변경될 수 있으며, 시간은 동일합니다.',
      prizes: [{ rank: 1, label: '우승', amount: '100만원' }, { rank: 2, label: '준우승', amount: '40만원' }, { rank: 0, label: '⚙️ 운영비', amount: '20만원', note: '경매내전 상품으로 사용' }], prizeNote: '16팀 기준 · 팀 수에 따라 변동',
      rules: ['팀원 5명 + 교체 인원 모두 디스코드 서버에 들어와 있어야 해요', '12/4까지 계정 인증을 마쳐야 해요', '팀 합계 점수가 제한을 넘으면 참가할 수 없어요'],
      sponsors: [{ target: '우승팀', item: '스킨 1350원씩 지급', cond: '팀원 전원', by: '벡스와럭스' }, { target: '우승팀', item: '맥도날드 빅맥세트', cond: '팀원 전원', by: '김태환' }, { target: '우승팀', item: '배민 3만원', cond: '랜덤 1인', anon: true },
        { target: '준우승팀', item: '편의점 3000원 쿠폰', by: '현냥' }, { target: '준우승팀', item: '1350원 스킨', cond: '마지막 판 딥롤 기준 ACE', by: '빠 더' }] };
    if (SEED === 'entry') { st.teams.d1.tr.entry = 'requested'; st.teams.d1.tr.entryReqAt = now - H; st.teams.d1.tg.entry = 'requested'; st.teams.d1.tg.entryReqAt = now - 2 * H; }
    if (SEED === 'rejected') { var mine = mkTeam('tm', '골드 타이거', '#E8C26A', '청룡', ['청룡', '백호', '주작', '정글러버', '민트초코'], 'rejected', { rejectReason: '팀 합계 점수가 200점을 넘어요. 한 명을 바꿔서 다시 신청해 주세요.' }); st.teams.d1.tm = mine; }
    if (SEED === 'scrims' || SEED === 'mine') {
      st.scrims.d1 = {};
      var s1 = scrimOf('s1', T.red, '금요일 밤 스크림', 3, null, [165, 185]);
      s1.apps.teams.tg = teamApp(T.green, null);
      [['폭풍전야', 'top'], ['정글러버', 'jg'], ['라떼', 'mid'], ['에스프레소', 'bot'], ['민트초코', 'sup'], ['검은고양이', 'jg']].forEach(function (x) { (s1.apps.solo[x[1]] = s1.apps.solo[x[1]] || {})[P(x[0]).did] = soloApp(x[0], x[1]); });
      st.scrims.d1.s1 = s1;
      if (SEED === 'mine') {
        var s2 = scrimOf('s2', T.blue, '블루 드래곤 연습 스크림', 2, { mid: '백호' }, [160, 200]);
        s2.apps.teams.tp = teamApp(T.purple, { bot: '칼날비' });
        [['폭풍전야', 'top'], ['청룡', 'top'], ['정글러버', 'jg'], ['검은고양이', 'jg'], ['라떼', 'mid'], ['에스프레소', 'bot'], ['주작', 'bot'], ['민트초코', 'sup']].forEach(function (x) { (s2.apps.solo[x[1]] = s2.apps.solo[x[1]] || {})[P(x[0]).did] = soloApp(x[0], x[1]); });
        st.scrims.d1.s2 = s2;
      }
    }
  }
  var isAdmin = ROLE === 'admin';
  function me() { return st.logged ? USERS[ROLE] : null; }

  // ── 디스코드 쪽 소식 (가이드 페이지가 받아서 디스코드 화면처럼 그려요) ──
  function emit(ev) { try { if (window.parent && window.parent !== window) window.parent.postMessage({ doomDemo: ev }, '*'); } catch (e) {} }
  function fmt(ms) { var d = new Date(ms), W = '일월화수목금토'; return (d.getMonth() + 1) + '.' + d.getDate() + '(' + W[d.getDay()] + ') ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  function line(l, m) { return '`' + EN[l] + '` **' + m.name + '** · ' + (m.tier || '티어 없음') + ' · ' + m.score + '점' + (m.sub && m.orig ? ' 🔁 교체 (원래 ' + m.orig.name + ')' : ''); }
  function post(s) {
    var d = st.dooms.d1, L = [];
    L.push('⚔️ **' + s.name + '** · ' + d.name + ' · **' + (s.status === 'ended' ? '🏁 종료' : s.status === 'matched' ? '✅ 성사' : '🟢 모집 중') + '**');
    L.push('🛡️ **' + s.teamName + '** (' + s.total + '점) · 팀장 ' + s.captain.name);
    L.push('⏰ 시작: **' + fmt(s.startAt) + '**');
    if (s.minScore !== '' || s.maxScore !== '') L.push('🎯 상대 합계 점수: ' + (s.minScore === '' ? '제한 없음' : s.minScore) + ' ~ ' + (s.maxScore === '' ? '제한 없음' : s.maxScore));
    if (s.note) L.push('⚠️ ' + s.note);
    L.push(''); LANES.forEach(function (l) { L.push(line(l, s.roster[l])); });
    if ((s.status === 'matched' || s.status === 'ended') && s.match) { L.push('', '✅ **성사 — ' + s.teamName + ' vs ' + s.match.name + '**'); LANES.forEach(function (l) { L.push(line(l, s.match.roster[l])); }); }
    else {
      var ts = Object.values(s.apps.teams || {}); L.push('', '👥 **팀 신청 ' + ts.length + '팀**'); ts.forEach(function (t) { L.push('• ' + t.teamName + ' (' + t.total + '점)'); });
      L.push('🙋 **개인 신청**'); LANES.forEach(function (l) { var xs = Object.values((s.apps.solo || {})[l] || {}); L.push('`' + EN[l] + '` ' + (xs.length ? xs.map(function (x) { return x.name + '(' + x.score + ')'; }).join(', ') : '—')); });
    }
    var closed = s.status !== 'open';
    return { kind: 'post', id: s.id, title: '⚔️ ' + s.name + ' · ' + s.teamName, content: L.join('\n'),
      buttons: [[{ label: '🎮 소환사 계정 등록', style: 2, id: 'register' }, { label: '👑 팀 스크림 신청(팀장전용)', style: 1, id: 'sc_team:' + s.id, disabled: closed }, { label: '🌐 웹에서 보기', style: 5, link: '#/d/d1/scrims/' + s.id }],
        LANES.map(function (l) { return { label: KO[l] + '(개인)', style: 3, id: 'sc_solo:' + s.id + ':' + l, disabled: closed }; }),
        [{ label: '❌ 개인 신청 취소', style: 4, id: 'sc_leave:' + s.id, disabled: closed }]] };
  }
  function emitPosts() { Object.values((st.scrims.d1) || {}).forEach(function (s) { emit(post(s)); }); }

  // ── 가짜 API (worker.js /doom 과 같은 모양으로 돌려줘요) ──
  function err(m) { var e = new Error(m); throw e; }
  function teamsOf(id) { return Object.values(st.teams[id] || {}); }
  function stOf(t) { return t.status || 'approved'; }
  function capOf(d) {
    var u = me(); if (!u) return { ok: false, team: null, reason: '디스코드 로그인이 필요해요' };
    var team = teamsOf(d.id).find(function (t) { return stOf(t) === 'approved' && t.captain && t.captain.did === u.did; }) || null;
    var roleOk = ROLE === 'captain' || ROLE === 'newcap';
    if (!roleOk) return { ok: false, team: team, reason: '팀장만 가능합니다' };
    if (!team) return { ok: false, team: null, reason: '팀장만 가능합니다 (이 멸망전에 수락된 내 팀이 없어요)' };
    return { ok: true, team: team, reason: '' };
  }
  function roster(team, subs) {
    var ro = {}, tot = 0, seen = {};
    LANES.forEach(function (l) { var o = team.members[l], sd = subs && subs[l]; var m = sd && sd !== o.did ? Object.assign(mem(POOL.find(function (p) { return p.did === sd; }), l), { sub: true, orig: clone(o) }) : clone(o); if (seen[m.did]) err(m.name + ' 님이 두 라인에 들어가 있어요'); seen[m.did] = 1; ro[l] = m; tot += m.score || 0; });
    var b = Number(team.bonus) || 0; return { roster: ro, base: r2(tot), bonus: b, total: r2(tot + b) };
  }
  function rangeErr(s, t) { if (s.minScore !== '' && s.minScore != null && t < s.minScore) return '합계 ' + t + '점이 최소 ' + s.minScore + '점보다 낮아요'; if (s.maxScore !== '' && s.maxScore != null && t > s.maxScore) return '합계 ' + t + '점이 최대 ' + s.maxScore + '점을 넘어요'; return ''; }
  var A = {
    list: function () { return { dooms: Object.values(st.dooms).map(function (d) { var ts = teamsOf(d.id); return Object.assign({}, d, { teamCount: ts.filter(function (t) { return stOf(t) === 'approved'; }).length, pendingCount: ts.filter(function (t) { return stOf(t) === 'pending'; }).length }); }), communityName: '데모 커뮤니티', isAdmin: isAdmin }; },
    get: function (b) { var d = st.dooms[b.doomId]; if (!d) err('없는 멸망전이에요'); var u = me(); return { doom: clone(d), teams: clone(teamsOf(d.id).filter(function (t) { return stOf(t) !== 'rejected' || isAdmin || (u && t.captain.did === u.did); })), isAdmin: isAdmin }; },
    me: function (b) { var u = me(); if (!u) return { user: null }; var d = st.dooms[b.doomId]; var cap = d ? capOf(d) : null; return { user: { did: u.did, name: u.name }, profile: { name: u.name, tag: u.tag || '' }, canCreate: true, reason: '', isAdmin: isAdmin, scrim: cap ? { ok: cap.ok, teamId: cap.team ? cap.team.id : null, reason: cap.reason } : null }; },
    pool: function () { return { pool: clone(POOL), table: clone(TABLE) }; },
    'refresh-cur': function () { return {}; },
    'admin-meta': function () { return { roles: ROLES, channels: CHANNELS, texts: TEXTS, cats: [{ id: 'k1', name: '멸망전 팀 음성' }, { id: 'k2', name: '음성 채널' }] }; },
    'team-voice': function (b) {
      var d = st.dooms[b.doomId], t = st.teams[b.doomId][b.team.id];
      if (!d.voiceCategoryId) err('멸망전 설정에서 "팀 음성 채팅방 카테고리"를 먼저 골라 달라고 관리자에게 알려 주세요');
      var granted = [], missing = [];
      LANES.forEach(function (l) { var m = t.members && t.members[l]; if (!m) return; if (/^\d+$/.test(String(m.did)) || /^u/.test(String(m.did))) granted.push(m.name + '#' + (m.tag || '')); else missing.push({ name: m.name + '#' + (m.tag || ''), why: 'nodc' }); });
      var created = !t.voice; t.voice = { id: 'v_' + t.id, name: '🔊 ' + t.name, at: Date.now() };
      return { voice: clone(t.voice), created: created, url: '', granted: granted, missing: missing };
    },
    save: function (b) { var x = b.doom || {}; if (!String(x.name || '').trim()) err('멸망전 이름을 입력해 주세요'); var id = x.id || 'd1'; var prev = st.dooms[id] || {}; st.dooms[id] = Object.assign({}, prev, clone(x), { id: id, createdAt: prev.createdAt || Date.now() }); if (!st.teams[id]) st.teams[id] = {}; return { doom: clone(st.dooms[id]) }; },
    delete: function (b) { delete st.dooms[b.doomId]; delete st.teams[b.doomId]; return {}; },
    'team-save': function (b) {
      var d = st.dooms[b.doomId], t = b.team || {}, u = me(), prev = t.id ? st.teams[d.id][t.id] : null;
      if (!String(t.name || '').trim()) err('팀 이름을 입력해 주세요');
      var members = {}, tot = 0;
      LANES.forEach(function (l) {
        var p = POOL.find(function (x) { return x.did === String((t.lanes || {})[l] || ''); }); if (!p) err('5개 라인을 모두 채워 주세요');
        var m = mem(p, l); var aj = isAdmin && t.adj && t.adj[l];
        if (aj) m = Object.assign(m, { tier: aj, src: 'adj', score: scoreOf(aj, l), adj: true, origTier: p.tier, origScore: p.scores[l] });
        else if (!isAdmin && prev && prev.members[l] && prev.members[l].adj && prev.members[l].did === p.did) m = prev.members[l];
        members[l] = m; tot += m.score || 0;
      });
      var bonus = isAdmin ? r2(t.bonus) : (prev ? prev.bonus || 0 : 0);
      var id = prev ? prev.id : 't' + Date.now().toString(36);
      st.teams[d.id][id] = { id: id, name: t.name, color: t.color, captain: prev ? prev.captain : (u ? { did: u.did, name: u.name } : { did: '', name: '관리자' }), members: members, base: r2(tot), bonus: bonus,
        bonusNote: isAdmin ? (t.bonusNote || '') : (prev ? prev.bonusNote || '' : ''), entry: prev ? prev.entry || null : null, entryNote: prev ? prev.entryNote || null : null, memo: isAdmin ? (prev ? prev.memo || '' : '') : (t.memo || ''), total: r2(tot + bonus), status: isAdmin ? (prev ? stOf(prev) : 'approved') : 'pending', createdAt: prev ? prev.createdAt : Date.now() };
      return { team: clone(st.teams[d.id][id]) };
    },
    'team-delete': function (b) { delete st.teams[b.doomId][b.team.id]; return {}; },
    'team-review': function (b) {
      var t = st.teams[b.doomId][b.team.id], ok = b.decision === 'approve';
      t.status = ok ? 'approved' : 'rejected'; t.rejectReason = ok ? null : String(b.reason || '').trim();
      emit({ kind: 'dm', to: t.captain.name, content: ok ? '✅ **' + st.dooms[b.doomId].name + '** 멸망전 팀 신청이 **수락**됐어요!\n\n🛡️ 팀: **' + t.name + '** (합계 ' + t.total + '점)'
        : '❌ **' + st.dooms[b.doomId].name + '** 멸망전 팀 신청이 **거절**됐어요.\n\n🛡️ 팀: **' + t.name + '**' + (t.rejectReason ? '\n📝 사유: ' + t.rejectReason : '') + '\n\n팀을 고쳐서 다시 신청할 수 있어요.', buttons: [[{ label: '멸망전 페이지 열기', style: 5, link: '#/d/' + b.doomId }]] });
      return { team: clone(t), dm: true };
    },
    'entry-request': function (b) {
      var t = st.teams[b.doomId][b.team.id], u = me();
      if (!u || t.captain.did !== u.did) err('팀장만 요청할 수 있어요'); if (b.agree !== true) err('주의사항에 동의해 주세요');
      t.entry = 'requested'; t.entryReqAt = Date.now(); t.entryNote = null; return {};
    },
    'og-save': function (b) { st.dooms[b.doomId].ogImage = b.ogImage || null; return { ogImage: b.ogImage || null }; },
    'info-save': function (b) { var d = st.dooms[b.doomId]; d.info = clone(b.info || {}); d.info.updatedAt = Date.now(); return { info: clone(d.info) }; },
    'entry-review': function (b) {
      var t = st.teams[b.doomId][b.team.id], d = st.dooms[b.doomId];
      if (b.decision === 'approve') { t.entry = 'confirmed'; t.entryAt = Date.now(); t.entryNote = null; }
      else if (b.decision === 'reject') { t.entry = null; t.entryNote = String(b.reason || '').trim() || null; }
      else { t.entry = null; t.entryNote = null; }
      if (b.decision !== 'revoke') emit({ kind: 'dm', to: t.captain.name, content: b.decision === 'approve' ? '🏆 **' + d.name + '** — **' + t.name + '** 팀의 **최종 출전이 확정**됐어요!'
        : '❌ **' + d.name + '** — **' + t.name + '** 팀의 최종 출전 확정 요청이 반려됐어요.' + (t.entryNote ? '\n📝 사유: ' + t.entryNote : '') + '\n조건을 확인한 뒤 다시 요청할 수 있어요.' });
      return { dm: b.decision !== 'revoke' };
    },
    'scrim-list': function (b) { return { scrims: clone(Object.values((st.scrims[b.doomId]) || {})) }; },
    'scrim-save': function (b) {
      var d = st.dooms[b.doomId], x = b.scrim || {}, s = b.scrimId ? st.scrims[d.id][b.scrimId] : null, team;
      if (s) team = st.teams[d.id][s.teamId]; else if (isAdmin && x.teamId) team = st.teams[d.id][x.teamId]; else { var cap = capOf(d); if (!cap.ok) err(cap.reason); team = cap.team; }
      if (!String(x.name || '').trim()) err('스크림 이름을 입력해 주세요'); if (!x.startAt) err('스크림 시작 시간을 정해 주세요');
      var R = roster(team, x.subs), id = s ? s.id : 's' + Date.now().toString(36);
      var num = function (v) { return v === '' || v == null || !isFinite(Number(v)) ? '' : r2(v); };
      st.scrims[d.id] = st.scrims[d.id] || {};
      st.scrims[d.id][id] = Object.assign(s || { apps: { teams: {}, solo: {} }, status: 'open', createdAt: Date.now(), threadId: 'th_' + id }, { id: id, doomId: d.id, name: x.name, desc: x.desc || '', note: x.note || '', recruitStart: x.recruitStart, recruitEnd: x.recruitEnd, startAt: x.startAt,
        minScore: num(x.minScore), maxScore: num(x.maxScore), teamId: team.id, teamName: team.name, teamColor: team.color, captain: team.captain, roster: R.roster, base: R.base, bonus: R.bonus, total: R.total });
      var p = post(st.scrims[d.id][id]); p.fresh = !s; emit(p);
      return { scrim: clone(st.scrims[d.id][id]), posted: true };
    },
    'scrim-delete': function (b) { if (!isAdmin) err('스크림 삭제는 관리자만 할 수 있어요'); delete st.scrims[b.doomId][b.scrimId]; emit({ kind: 'post-delete', id: b.scrimId }); return {}; },
    'scrim-solo': function (b) { return soloApply(b.scrimId, b.lane); },
    'scrim-solo-leave': function (b) { var s = st.scrims.d1[b.scrimId], u = me(); LANES.forEach(function (l) { if (s.apps.solo[l]) delete s.apps.solo[l][u.did]; }); emit(post(s)); return {}; },
    'scrim-team-apply': function (b) {
      var d = st.dooms[b.doomId], s = st.scrims[d.id][b.scrimId], cap = capOf(d); if (!cap.ok) err(cap.reason); if (cap.team.id === s.teamId) err('내 팀이 연 스크림이에요');
      var R = roster(cap.team, b.subs), re = rangeErr(s, R.total); if (re) err('스크림 점수 조건에 맞지 않아요 — ' + re);
      var again = !!s.apps.teams[cap.team.id];
      s.apps.teams[cap.team.id] = { id: cap.team.id, teamId: cap.team.id, teamName: cap.team.name, teamColor: cap.team.color, captain: cap.team.captain, roster: R.roster, base: R.base, bonus: R.bonus, total: R.total, at: Date.now() };
      emit(post(s)); return { app: clone(s.apps.teams[cap.team.id]), again: again };
    },
    'scrim-team-cancel': function (b) { var d = st.dooms[b.doomId], s = st.scrims[d.id][b.scrimId], cap = capOf(d); delete s.apps.teams[cap.team.id]; emit(post(s)); return {}; },
    'scrim-rooms': function (b) {
      var s = st.scrims[b.doomId][b.scrimId], d = st.dooms[b.doomId];
      if (s.status !== 'matched') err('성사된 스크림에서만 방을 만들 수 있어요');
      if (!d.scrimVoiceCategoryId) err('멸망전 설정에서 "스크림 음성 채팅방 카테고리"를 먼저 골라 달라고 관리자에게 알려 주세요');
      s.rooms = [{ key: 'sep', id: 'r0', name: '══════ [스크림] ' + s.teamName + ' vs ' + s.match.name + ' ══════', url: '' }, { key: 'lobby', id: 'r1', name: '[스크림] ' + s.teamName + ' vs ' + s.match.name + ' 대기실', url: '' }, { key: 'host', id: 'r2', name: s.teamName, url: '' }, { key: 'opp', id: 'r3', name: s.match.name, url: '' }];
      return { rooms: clone(s.rooms) };
    },
    'scrim-end': function (b) { var s = st.scrims[b.doomId][b.scrimId]; if (s.status !== 'matched') err('성사된 스크림만 종료할 수 있어요'); var n = (s.rooms || []).length; s.status = 'ended'; s.endedAt = Date.now(); s.rooms = null; return { deleted: n }; },
    'scrim-match': function (b) {
      var s = st.scrims[b.doomId][b.scrimId], match;
      if (b.type === 'team') { var a = s.apps.teams[b.appId]; match = { type: 'team', name: a.teamName, color: a.teamColor, captain: a.captain, roster: a.roster, total: a.total }; }
      else { var ro = {}, tot = 0; LANES.forEach(function (l) { var x = s.apps.solo[l] && s.apps.solo[l][b.picks[l]]; if (!x) err(KO[l] + ' 신청자를 골라 주세요'); ro[l] = x; tot += x.score || 0; }); tot = r2(tot); var re = rangeErr(s, tot); if (re) err('스크림 점수 조건에 맞지 않아요 — ' + re); match = { type: 'solo', name: b.name || '개인 연합팀', color: '#B07CF0', captain: null, roster: ro, total: tot }; }
      match.at = Date.now(); match.threadId = 'pt_' + s.id; s.status = 'matched'; s.match = match;
      var head = '✅ **스크림 성사!** — ' + st.dooms.d1.name + '\n⚔️ **' + s.name + '** · ' + s.teamName + ' vs ' + match.name + '\n⏰ 시작: **' + fmt(s.startAt) + '**';
      var btn = [[{ label: '스크림 보기', style: 5, link: '#/d/d1/scrims/' + s.id }, { label: '비공개 스레드', style: 5, thread: true }]];
      var targets = match.type === 'team' ? [{ to: match.captain.name, text: head + '\n\n👑 **' + match.name + '** 팀의 스크림 신청이 성사됐어요.' }]
        : LANES.map(function (l) { return { to: match.roster[l].name, text: head + '\n\n🙋 개인 신청이 뽑혔어요 — **' + KO[l] + '** · ' + match.roster[l].name }; });
      emit({ kind: 'thread', name: '🔒 ' + s.name + ' · ' + s.teamName + ' vs ' + match.name, content: '⚔️ **' + s.name + '** 스크림이 성사됐어요!\n⏰ 시작: **' + fmt(s.startAt) + '**\n\n**' + s.teamName + '**\n' + LANES.map(function (l) { return line(l, s.roster[l]); }).join('\n') + '\n\n**' + match.name + '**\n' + LANES.map(function (l) { return line(l, match.roster[l]); }).join('\n'),
        members: LANES.map(function (l) { return s.roster[l].name; }).concat(LANES.map(function (l) { return match.roster[l].name; })) });
      targets.forEach(function (t) { emit({ kind: 'dm', to: t.to, content: t.text, buttons: btn }); });
      emit(post(s));
      return { sent: targets.length, total: targets.length, threadId: match.threadId };
    },
  };
  function soloApply(sid, lane) {
    var s = st.scrims.d1[sid], u = me(); if (!u) err('디스코드 로그인이 필요해요');
    if (s.status !== 'open') err('이미 성사된 스크림이에요');
    if (Object.values(s.roster).some(function (m) { return m.did === u.did; })) err('상대 팀(이 스크림을 연 팀) 로스터에 있어서 개인 신청은 할 수 없어요');
    var moved = ''; LANES.forEach(function (l) { if (l !== lane && s.apps.solo[l] && s.apps.solo[l][u.did]) { delete s.apps.solo[l][u.did]; moved = l; } });
    (s.apps.solo[lane] = s.apps.solo[lane] || {})[u.did] = Object.assign(mem(u, lane), { at: Date.now() });
    emit(post(s)); return { moved: moved };
  }

  window.DOOM_DEMO = {
    role: ROLE, seed: SEED,
    discord: function () { var u = me(); return u ? { dtoken: 'demo', user: { id: u.did, displayName: u.name } } : null; },
    login: function () { st.logged = true; emit({ kind: 'login', name: USERS[ROLE].name }); },
    api: async function (action, body) {
      await new Promise(function (r) { setTimeout(r, 120); });   // 실제처럼 살짝 기다려요
      var f = A[action]; if (!f) throw new Error('체험 모드에서 쓸 수 없는 기능이에요');
      return Object.assign({ ok: true }, f(body || {}));
    },
    // 가이드의 디스코드 화면에서 누른 버튼
    discordClick: function (id) {
      var p = id.split(':');
      try {
        if (p[0] === 'register') return { content: '🎮 **소환사 계정 등록**\n라이엇 ID(닉네임#태그)와 주 라인을 입력하면 등록돼요. 등록하면 멸망전 팀 신청 · 스크림 신청에 바로 쓸 수 있어요.' };
        if (p[0] === 'sc_solo') { var r = soloApply(p[1], p[2]), u = me(), s = st.scrims.d1[p[1]]; return { content: '✅ **' + s.name + '** 스크림에 **' + KO[p[2]] + '(개인)**으로 신청했어요.' + (r.moved ? ' (' + KO[r.moved] + ' 신청은 옮겼어요)' : '') + '\n' + u.name + ' · ' + u.tier + ' · ' + u.scores[p[2]] + '점\n성사되면 디스코드 DM으로 알려 드려요.' }; }
        if (p[0] === 'sc_leave') { A['scrim-solo-leave']({ scrimId: p[1] }); return { content: '✅ 개인 신청을 취소했어요.' }; }
        if (p[0] === 'sc_team') { var cap = capOf(st.dooms.d1); if (!cap.ok) return { content: '❌ ' + cap.reason }; return { content: '👑 **' + cap.team.name + '** 팀으로 신청하는 페이지예요.\n교체할 인원을 정한 뒤 **스크림 신청하기**를 눌러 주세요.', buttons: [[{ label: '팀 스크림 신청 열기', style: 5, link: '#/d/d1/scrims/' + p[1] + '/apply' }]] }; }
      } catch (e) { return { content: '❌ ' + e.message }; }
      return { content: '' };
    },
    // 가이드에서 다른 사람이 한 일처럼 꾸며요 (예: 관리자가 내 팀을 수락)
    sim: function (what) {
      if (what === 'approve-mine') { var u = me(), t = teamsOf('d1').find(function (x) { return x.captain.did === u.did; }); if (t) { var isA = isAdmin; isAdmin = true; A['team-review']({ doomId: 'd1', team: { id: t.id }, decision: 'approve' }); isAdmin = isA; } }
      if (what === 'posts') emitPosts();
      if (what === 'entry-approve-mine') { var u2 = me(), t2 = teamsOf('d1').find(function (x) { return x.captain.did === u2.did; }); if (t2) A['entry-review']({ doomId: 'd1', team: { id: t2.id }, decision: 'approve' }); }
    },
    posts: function () { return Object.values(st.scrims.d1 || {}).map(post); },
  };
})();
