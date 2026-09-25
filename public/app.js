(function () {
  'use strict';

  var STORAGE_KEY = 'microplastic-dedup-draft-v1';
  var MIN_FIELDS = 3;
  var MAX_FIELDS = 5;

  function newParticle() {
    return { id: '', x: '', y: '', category: '' };
  }
  function newField(name) {
    return { name: name || '', offsetX: '0', offsetY: '0', particles: [newParticle()] };
  }
  function defaultState() {
    return { tolerance: '5', fields: [newField('F1'), newField('F2'), newField('F3')] };
  }

  function loadDraft() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || !Array.isArray(s.fields) || s.fields.length === 0) return null;
      return s;
    } catch (e) {
      return null;
    }
  }

  var state = loadDraft() || defaultState();

  function saveDraft() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) { /* 存储不可用时草稿仍保留在内存中 */ }
  }

  var fieldsEl = document.getElementById('fields');
  var issuesEl = document.getElementById('issues');
  var toleranceEl = document.getElementById('tolerance');
  var addFieldBtn = document.getElementById('btn-add-field');
  var resultPanel = document.getElementById('result-panel');
  var resultSummary = document.getElementById('result-summary');
  var resultParticles = document.getElementById('result-particles');
  var resultJson = document.getElementById('result-json');
  var submitHint = document.getElementById('submit-hint');
  var createEvidenceBtn = document.getElementById('btn-create-evidence');
  var evidenceCreateHint = document.getElementById('evidence-create-hint');
  var evidencePanel = document.getElementById('evidence-panel');
  var evidenceStatus = document.getElementById('evidence-status');
  var evidenceSummary = document.getElementById('evidence-summary');
  var evidenceProgress = document.getElementById('evidence-progress');
  var evidenceAlert = document.getElementById('evidence-alert');
  var evidenceLinks = document.getElementById('evidence-links');
  var evidenceMessage = document.getElementById('evidence-message');
  var evidenceRetryBtn = document.getElementById('btn-evidence-retry');

  // 最近一次成功裁决所提交的完整草稿（证据单以其为准重新裁决并冻结）
  var lastAdjudicatedPayload = null;
  // 当前打开的证据单与进行中的复核提交（网络失败时按原操作号重试）
  var currentSheet = null;
  var pendingReview = null;
  var reviewInFlight = false;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function render() {
    toleranceEl.value = state.tolerance;
    var html = state.fields.map(function (f, fi) {
      var rows = f.particles.map(function (p, pi) {
        return '<tr>' +
          '<td><input data-path="fields[' + fi + '].particles[' + pi + '].id" data-field="' + fi + '" data-particle="' + pi + '" data-key="id" value="' + esc(p.id) + '" placeholder="如 A1"></td>' +
          '<td><input data-path="fields[' + fi + '].particles[' + pi + '].x" data-field="' + fi + '" data-particle="' + pi + '" data-key="x" type="number" step="1" value="' + esc(p.x) + '"></td>' +
          '<td><input data-path="fields[' + fi + '].particles[' + pi + '].y" data-field="' + fi + '" data-particle="' + pi + '" data-key="y" type="number" step="1" value="' + esc(p.y) + '"></td>' +
          '<td><input data-path="fields[' + fi + '].particles[' + pi + '].category" data-field="' + fi + '" data-particle="' + pi + '" data-key="category" list="categories" value="' + esc(p.category) + '" placeholder="PE / PP / …"></td>' +
          '<td><button type="button" class="small" data-action="remove-particle" data-field="' + fi + '" data-particle="' + pi + '">删除</button></td>' +
          '</tr>';
      }).join('');
      return '<div class="field-card">' +
        '<div class="field-head">' +
          '<strong>视野 ' + (fi + 1) + '</strong>' +
          '<label>名称<input data-path="fields[' + fi + '].name" data-field="' + fi + '" data-key="name" value="' + esc(f.name) + '" placeholder="F' + (fi + 1) + '"></label>' +
          '<label>平移 X<input data-path="fields[' + fi + '].offset.x" data-field="' + fi + '" data-key="offsetX" type="number" step="1" value="' + esc(f.offsetX) + '"></label>' +
          '<label>平移 Y<input data-path="fields[' + fi + '].offset.y" data-field="' + fi + '" data-key="offsetY" type="number" step="1" value="' + esc(f.offsetY) + '"></label>' +
          '<span class="spacer"></span>' +
          '<button type="button" class="small" data-action="remove-field" data-field="' + fi + '"' + (state.fields.length <= MIN_FIELDS ? ' disabled' : '') + '>删除视野</button>' +
        '</div>' +
        '<table class="particles"><thead><tr><th>颗粒编号</th><th>X（视野内）</th><th>Y（视野内）</th><th>聚合物类别</th><th></th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>' +
        '<button type="button" class="ghost small" data-action="add-particle" data-field="' + fi + '">＋ 添加颗粒</button>' +
        '</div>';
    }).join('');
    fieldsEl.innerHTML = html;
    addFieldBtn.disabled = state.fields.length >= MAX_FIELDS;
  }

  // 输入变更：更新状态并保存草稿（不重渲染，避免打断输入）
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t === toleranceEl) {
      state.tolerance = t.value;
      saveDraft();
      return;
    }
    if (!t.dataset || t.dataset.field === undefined || !t.dataset.key) return;
    var f = state.fields[Number(t.dataset.field)];
    if (!f) return;
    if (t.dataset.particle !== undefined) {
      var p = f.particles[Number(t.dataset.particle)];
      if (p) p[t.dataset.key] = t.value;
    } else {
      f[t.dataset.key] = t.value;
    }
    saveDraft();
  });

  // 增删视野 / 颗粒
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-action]');
    if (!btn) return;
    var fi = Number(btn.dataset.field);
    var action = btn.dataset.action;
    if (action === 'add-particle') {
      state.fields[fi].particles.push(newParticle());
    } else if (action === 'remove-particle') {
      state.fields[fi].particles.splice(Number(btn.dataset.particle), 1);
    } else if (action === 'remove-field') {
      if (state.fields.length > MIN_FIELDS) state.fields.splice(fi, 1);
    } else {
      return;
    }
    saveDraft();
    render();
  });

  addFieldBtn.addEventListener('click', function () {
    if (state.fields.length < MAX_FIELDS) {
      state.fields.push(newField());
      saveDraft();
      render();
    }
  });

  document.getElementById('btn-clear').addEventListener('click', function () {
    if (!window.confirm('确定清空当前草稿？')) return;
    state = defaultState();
    saveDraft();
    clearIssues();
    hideResult();
    render();
  });

  document.getElementById('btn-sample').addEventListener('click', function () {
    state = {
      tolerance: '5',
      fields: [
        {
          name: 'F1', offsetX: '0', offsetY: '0',
          particles: [
            { id: 'A1', x: '10', y: '10', category: 'PE' },
            { id: 'A2', x: '40', y: '40', category: 'PP' },
            { id: 'A3', x: '90', y: '10', category: 'PE' },
          ],
        },
        {
          name: 'F2', offsetX: '100', offsetY: '0',
          particles: [
            { id: 'B1', x: '-8', y: '12', category: 'PE' },
            { id: 'B2', x: '-6', y: '9', category: 'PE' },
          ],
        },
        {
          name: 'F3', offsetX: '0', offsetY: '100',
          particles: [
            { id: 'C1', x: '40', y: '-58', category: 'PP' },
            { id: 'C2', x: '5', y: '5', category: 'PET' },
          ],
        },
      ],
    };
    saveDraft();
    clearIssues();
    hideResult();
    render();
    submitHint.textContent = '已载入示例，可直接发起去重裁决。';
  });

  function clearIssues() {
    issuesEl.classList.add('hidden');
    issuesEl.innerHTML = '';
    document.querySelectorAll('input.invalid').forEach(function (el) {
      el.classList.remove('invalid');
    });
  }

  function showIssues(issues, heading) {
    var items = issues.map(function (it) {
      var where = it.path ? '<code>' + esc(it.path) + '</code> ' : '';
      return '<li>' + where + esc(it.message) + '</li>';
    }).join('');
    issuesEl.innerHTML = '<h3>' + esc(heading || '输入不合规，请修正后重新提交（草稿已保留）') + '</h3><ul>' + items + '</ul>';
    issuesEl.classList.remove('hidden');
    var firstInput = null;
    issues.forEach(function (it) {
      if (!it.path) return;
      var el = document.querySelector('[data-path="' + it.path.replace(/"/g, '\\"') + '"]');
      if (el) {
        el.classList.add('invalid');
        if (!firstInput) firstInput = el;
      }
    });
    issuesEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (firstInput) firstInput.focus({ preventScroll: true });
  }

  function hideResult() {
    resultPanel.classList.add('hidden');
  }

  function renderResult(result) {
    resultSummary.innerHTML =
      '最终颗粒总数：<span class="ok">' + result.totalParticles + '</span>' +
      '（共 ' + result.observationCount + ' 个观测，选中关联 ' + result.linkCount + ' 条，容差 ' + result.tolerance + '）';

    resultParticles.innerHTML = result.particles.map(function (p) {
      var obsRows = p.observations.map(function (o) {
        return '<tr><td>' + esc(o.fieldName) + '</td><td>' + esc(o.particleId) + '</td>' +
          '<td>(' + o.localX + ', ' + o.localY + ')</td><td>(' + o.filterX + ', ' + o.filterY + ')</td></tr>';
      }).join('');
      var links = p.links.length === 0
        ? '<span class="none">无关联（独立颗粒）</span>'
        : p.links.map(function (l) {
            return '<span class="link-chip">' + esc(l.a) + ' ↔ ' + esc(l.b) + '（曼哈顿差 ' + l.manhattan + '）</span>';
          }).join('');
      return '<div class="particle-card">' +
        '<header><span class="pid">颗粒 #' + p.id + '</span>' +
        '<span class="badge">类别 ' + esc(p.category) + '</span>' +
        '<span>代表坐标：(' + p.representative.x + ', ' + p.representative.y + ')</span>' +
        '<span>观测数：' + p.observations.length + '</span></header>' +
        '<table><thead><tr><th>视野</th><th>颗粒编号</th><th>局部坐标</th><th>滤膜坐标</th></tr></thead>' +
        '<tbody>' + obsRows + '</tbody></table>' +
        '<div class="links">' + links + '</div>' +
        '</div>';
    }).join('');

    resultJson.textContent = JSON.stringify(result, null, 2);
    resultPanel.classList.remove('hidden');
    resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // 数值转换：空串 → null、非数字 → 原样字符串，交由服务端给出可定位反馈
  function num(v) {
    var s = String(v == null ? '' : v).trim();
    if (s === '') return null;
    var n = Number(s);
    return Number.isNaN(n) ? s : n;
  }

  document.getElementById('btn-submit').addEventListener('click', function () {
    clearIssues();
    hideResult();
    var payload = {
      tolerance: num(state.tolerance),
      fields: state.fields.map(function (f, fi) {
        return {
          name: String(f.name || '').trim() || ('F' + (fi + 1)),
          offset: { x: num(f.offsetX), y: num(f.offsetY) },
          particles: f.particles.map(function (p) {
            return { id: String(p.id == null ? '' : p.id), x: num(p.x), y: num(p.y), category: String(p.category == null ? '' : p.category) };
          }),
        };
      }),
    };

    submitHint.textContent = '裁决中…';
    fetch('/api/particle-deduplications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json().then(function (body) { return { res: res, body: body }; });
      })
      .then(function (r) {
        if (!r.res.ok) {
          var err = (r.body && r.body.error) || {};
          var issues = Array.isArray(err.issues) && err.issues.length > 0
            ? err.issues
            : [{ path: '', message: err.message || ('请求失败（HTTP ' + r.res.status + '）') }];
          showIssues(issues, err.message);
          submitHint.textContent = '';
          return;
        }
        submitHint.textContent = '裁决完成。';
        lastAdjudicatedPayload = payload;
        evidenceCreateHint.textContent = '以本次裁决的完整草稿在服务端重新裁决并冻结结论，供人工复核。';
        renderResult(r.body);
      })
      .catch(function () {
        showIssues([{ path: '', message: '网络或服务器错误，请稍后重试（草稿已保留）' }]);
        submitHint.textContent = '';
      });
  });

  // ── 复测证据单 ────────────────────────────────────────────────

  var STATUS_TEXT = { pending: '复核中', verified: '已证实', needs_readjudication: '需重裁决' };

  function newOperationId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'op-' + Date.now() + '-' + Math.random().toString(36).slice(2, 12);
  }

  function fmtTime(iso) {
    try { return new Date(iso).toLocaleString(); } catch (e) { return iso; }
  }

  function obsText(o) {
    return esc(o.fieldName) + ' · ' + esc(o.particleId) +
      '<br><span class="muted">局部 (' + o.localX + ', ' + o.localY + ') → 滤膜 (' + o.filterX + ', ' + o.filterY + ')</span>';
  }

  function renderEvidence(sheet) {
    currentSheet = sheet;
    evidencePanel.classList.remove('hidden');

    evidenceStatus.textContent = STATUS_TEXT[sheet.status] || sheet.status;
    evidenceStatus.className = 'badge status-' + sheet.status;

    var src = sheet.source;
    evidenceSummary.innerHTML =
      '<div><strong>证据单 #' + sheet.id + '</strong>（版本 v' + sheet.version + '，创建于 ' + esc(fmtTime(sheet.createdAt)) + '）</div>' +
      '<div class="muted">冻结来源：容差 ' + src.tolerance + '，' + src.fieldCount + ' 个视野（' +
      src.fields.map(function (f) { return esc(f.name) + ' ' + f.particleCount + ' 颗'; }).join('、') + '），共 ' +
      src.observationCount + ' 个观测；来源摘要哈希 <code>' + esc(src.hash.slice(0, 16)) + '…</code></div>' +
      '<div class="muted">冻结结论：最终颗粒 ' + sheet.result.totalParticles + ' 个，采用关联 ' + sheet.result.linkCount +
      ' 条。证据单按创建时刻的完整草稿冻结，当前草稿的后续修改不会改写本证据。</div>';

    var p = sheet.progress;
    var pct = p.total === 0 ? 100 : Math.round(((p.confirmed + p.rejected) / p.total) * 100);
    evidenceProgress.innerHTML =
      '<div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="muted">进度：已确认 ' + p.confirmed + ' / 共 ' + p.total + ' 条关联；已否决 ' + p.rejected +
      ' 条；剩余待复核 ' + p.remaining + ' 条。</div>';

    if (sheet.firstRejectedLinkId !== null) {
      var rl = sheet.links.filter(function (l) { return l.linkId === sheet.firstRejectedLinkId; })[0];
      evidenceAlert.innerHTML = rl
        ? '⚠ 首条否决关联：#' + rl.linkId + '（' + esc(rl.a.particleId) + ' ↔ ' + esc(rl.b.particleId) +
          '，类别 ' + esc(rl.category) + '，坐标差 Δx=' + rl.dx + '、Δy=' + rl.dy + '）—— 正是这条显微关联阻止本次颗粒计数被证实，请修正草稿后重新裁决并创建新证据单。'
        : '⚠ 存在否决关联，本次计数未获证实。';
      evidenceAlert.classList.remove('hidden');
    } else if (sheet.status === 'verified') {
      evidenceAlert.innerHTML = '✓ 全部采用关联均获确认，本次颗粒计数已证实。';
      evidenceAlert.classList.remove('hidden');
    } else {
      evidenceAlert.classList.add('hidden');
      evidenceAlert.innerHTML = '';
    }

    var closed = sheet.status !== 'pending';
    evidenceLinks.innerHTML = sheet.links.length === 0
      ? '<p class="muted">本次裁决未采用任何关联（零关联），无需逐条复核。</p>'
      : '<table class="evidence-table"><thead><tr>' +
        '<th>关联</th><th>所属颗粒</th><th>类别</th><th>端点 A</th><th>端点 B</th><th>坐标差</th><th>复核结论</th>' +
        '</tr></thead><tbody>' +
        sheet.links.map(function (l) {
          var decisionCell;
          if (l.decision === 'confirmed') {
            decisionCell = '<span class="badge decided-confirm">已确认</span>';
          } else if (l.decision === 'rejected') {
            decisionCell = '<span class="badge decided-reject">已否决</span>';
          } else if (closed) {
            decisionCell = '<span class="muted">待复核（证据单已终结）</span>';
          } else {
            decisionCell =
              '<button type="button" class="small" data-evidence-action="confirm" data-link="' + l.linkId + '"' + (reviewInFlight ? ' disabled' : '') + '>确认</button> ' +
              '<button type="button" class="small danger" data-evidence-action="reject" data-link="' + l.linkId + '"' + (reviewInFlight ? ' disabled' : '') + '>否决</button>';
          }
          return '<tr>' +
            '<td>#' + l.linkId + '</td>' +
            '<td>颗粒 #' + l.particleId + '</td>' +
            '<td>' + esc(l.category) + '</td>' +
            '<td>' + obsText(l.a) + '</td>' +
            '<td>' + obsText(l.b) + '</td>' +
            '<td>Δx=' + l.dx + '<br>Δy=' + l.dy + '<br><span class="muted">曼哈顿 ' + l.manhattan + '</span></td>' +
            '<td>' + decisionCell + '</td>' +
            '</tr>';
        }).join('') + '</tbody></table>';
  }

  function setEvidenceMessage(text, isError) {
    evidenceMessage.textContent = text || '';
    evidenceMessage.classList.toggle('error-text', !!isError);
  }

  function refreshEvidence() {
    if (!currentSheet) return;
    fetch('/api/review-evidence-sheets/' + currentSheet.id)
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (sheet) { if (sheet) renderEvidence(sheet); })
      .catch(function () { /* 轮询失败静默，下次再试 */ });
  }

  function submitReview(payload) {
    if (!currentSheet || reviewInFlight) return;
    reviewInFlight = true;
    renderEvidence(currentSheet);
    setEvidenceMessage('提交复核中…（操作号 ' + payload.operationId + '）');
    fetch('/api/review-evidence-sheets/' + currentSheet.id + '/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json().then(function (body) { return { res: res, body: body }; });
      })
      .then(function (r) {
        reviewInFlight = false;
        if (r.res.ok) {
          pendingReview = null;
          evidenceRetryBtn.classList.add('hidden');
          setEvidenceMessage(r.body.idempotentReplay ? '该操作号已提交过，返回原结果（幂等重放）。' : '复核已记录。');
          renderEvidence(r.body);
          return;
        }
        var err = (r.body && r.body.error) || {};
        setEvidenceMessage(err.message || ('提交被拒绝（HTTP ' + r.res.status + '）'), true);
        refreshEvidence(); // 版本过期等情形：刷新到最新状态
      })
      .catch(function () {
        reviewInFlight = false;
        pendingReview = payload; // 保留同一操作号，重试不产生重复判定
        evidenceRetryBtn.classList.remove('hidden');
        setEvidenceMessage('网络或服务器错误，可按原操作号重试（不会重复判定）。', true);
        renderEvidence(currentSheet);
      });
  }

  evidenceRetryBtn.addEventListener('click', function () {
    if (pendingReview) submitReview(pendingReview);
  });

  // 复核按钮（事件委托）
  evidenceLinks.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-evidence-action]');
    if (!btn || !currentSheet) return;
    submitReview({
      version: currentSheet.version,
      operationId: newOperationId(),
      decisions: [{ linkId: Number(btn.dataset.link), decision: btn.dataset.evidenceAction }],
    });
  });

  // 创建证据单：以本次裁决的完整草稿在服务端重新裁决并冻结
  createEvidenceBtn.addEventListener('click', function () {
    if (!lastAdjudicatedPayload) return;
    createEvidenceBtn.disabled = true;
    evidenceCreateHint.textContent = '正在创建证据单…';
    fetch('/api/review-evidence-sheets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lastAdjudicatedPayload),
    })
      .then(function (res) {
        return res.json().then(function (body) { return { res: res, body: body }; });
      })
      .then(function (r) {
        createEvidenceBtn.disabled = false;
        if (!r.res.ok) {
          var err = (r.body && r.body.error) || {};
          evidenceCreateHint.textContent = err.message || ('创建失败（HTTP ' + r.res.status + '）');
          return;
        }
        evidenceCreateHint.textContent = '已创建证据单 #' + r.body.id + '（冻结版本 v' + r.body.version + '）。';
        pendingReview = null;
        evidenceRetryBtn.classList.add('hidden');
        setEvidenceMessage('');
        renderEvidence(r.body);
        evidencePanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      })
      .catch(function () {
        createEvidenceBtn.disabled = false;
        evidenceCreateHint.textContent = '网络或服务器错误，创建失败，请重试。';
      });
  });

  // 页面加载时恢复最近一份证据单；复核中每 5 秒刷新进度（持续显示冻结来源 / 剩余项 / 进度 / 首条否决关联）
  fetch('/api/review-evidence-sheets')
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (body) {
      if (!body || !Array.isArray(body.sheets) || body.sheets.length === 0) return null;
      var latest = body.sheets[body.sheets.length - 1];
      return fetch('/api/review-evidence-sheets/' + latest.id);
    })
    .then(function (res) { return res && res.ok ? res.json() : null; })
    .then(function (sheet) { if (sheet) renderEvidence(sheet); })
    .catch(function () { /* 首次访问无证据单或服务暂不可用 */ });

  setInterval(function () {
    if (currentSheet && currentSheet.status === 'pending' && !reviewInFlight) refreshEvidence();
  }, 5000);

  render();
})();
