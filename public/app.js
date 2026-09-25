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
        lastAdjudicatedPayload = payload; // 冻结“当时完整草稿”，供创建证据单使用
        ticketCreateHint.textContent = '';
        renderResult(r.body);
      })
      .catch(function () {
        showIssues([{ path: '', message: '网络或服务器错误，请稍后重试（草稿已保留）' }]);
        submitHint.textContent = '';
      });
  });

  // ── 复测证据单 ─────────────────────────────────────────────
  var lastAdjudicatedPayload = null; // 最近一次裁决成功时的完整草稿
  var openTicketState = null;        // { ticket, decisions: {linkIndex: 'confirmed'|'rejected'} }

  var ticketListEl = document.getElementById('ticket-list');
  var ticketDetailEl = document.getElementById('ticket-detail');
  var ticketHeadEl = document.getElementById('ticket-head');
  var ticketSourceEl = document.getElementById('ticket-source');
  var ticketProgressEl = document.getElementById('ticket-progress');
  var ticketFirstRejectedEl = document.getElementById('ticket-first-rejected');
  var ticketLinksEl = document.getElementById('ticket-links');
  var ticketCreateHint = document.getElementById('ticket-create-hint');
  var reviewHint = document.getElementById('review-hint');

  var STATUS_LABEL = { 'pending': '复核中', 'verified': '已证实', 'needs-readjudication': '需重裁决' };

  function fetchJson(path, options) {
    return fetch(path, options).then(function (res) {
      return res.json().then(function (body) { return { res: res, body: body }; });
    });
  }

  // 操作号由提交内容确定：同内容重试天然携带同一操作号（幂等），内容一变操作号即变
  function hashStr(s) {
    var h1 = 5381;
    var h2 = 52711;
    for (var i = 0; i < s.length; i++) {
      h1 = ((h1 * 33) ^ s.charCodeAt(i)) >>> 0;
      h2 = ((h2 * 31) ^ s.charCodeAt(i)) >>> 0;
    }
    return h1.toString(16) + h2.toString(16);
  }
  function operationIdFor(ticketId, version, decisions) {
    var s = decisions.map(function (d) { return d.linkIndex + ':' + d.decision; }).sort().join(',');
    return 'web-t' + ticketId + '-v' + version + '-' + hashStr(s);
  }

  function fmtTime(iso) {
    try { return new Date(iso).toLocaleString(); } catch (e) { return iso; }
  }

  function statusBadge(status) {
    return '<span class="status-badge status-' + esc(status) + '">' + esc(STATUS_LABEL[status] || status) + '</span>';
  }

  function renderTicketList(tickets) {
    if (!tickets || tickets.length === 0) {
      ticketListEl.innerHTML = '<p class="hint">暂无证据单。裁决成功后，可在结果旁创建复测证据单。</p>';
      return;
    }
    ticketListEl.innerHTML = tickets.map(function (t) {
      var p = t.progress;
      return '<button type="button" class="ticket-item" data-ticket-id="' + t.id + '">' +
        '<span class="tid">#' + t.id + '</span>' + statusBadge(t.status) +
        '<span>进度 ' + p.confirmed + '/' + p.total + '，剩余 ' + p.remaining + '</span>' +
        (t.firstRejectedLinkIndex !== null ? '<span class="rej">首条否决：关联 #' + t.firstRejectedLinkIndex + '</span>' : '') +
        '<span class="muted">' + esc(fmtTime(t.createdAt)) + '</span>' +
        '</button>';
    }).join('');
  }

  function loadTickets(selectId) {
    fetchJson('/api/review-tickets')
      .then(function (r) {
        if (!r.res.ok) return;
        renderTicketList(r.body.tickets);
        if (selectId !== undefined && selectId !== null) openTicket(selectId);
      })
      .catch(function () { /* 列表加载失败不影响录入 */ });
  }

  function syncDecisionsFromTicket() {
    var decisions = {};
    openTicketState.ticket.links.forEach(function (l) {
      if (l.decision !== 'pending') decisions[l.index] = l.decision;
    });
    openTicketState.decisions = decisions;
  }

  function openTicket(id) {
    fetchJson('/api/review-tickets/' + id)
      .then(function (r) {
        if (!r.res.ok) return;
        openTicketState = { ticket: r.body, decisions: {} };
        syncDecisionsFromTicket();
        renderTicketDetail();
      })
      .catch(function () { /* 忽略 */ });
  }

  function obsText(o) {
    return esc(o.fieldName) + ' / ' + esc(o.particleId) + '（滤膜坐标 ' + o.filterX + ', ' + o.filterY + '）';
  }

  function renderTicketDetail() {
    var t = openTicketState.ticket;
    var p = t.progress;
    ticketDetailEl.classList.remove('hidden');

    ticketHeadEl.innerHTML =
      '<span class="tid">证据单 #' + t.id + '</span>' + statusBadge(t.status) +
      '<span class="muted">版本 v' + t.version + ' · 创建于 ' + esc(fmtTime(t.createdAt)) + ' · 更新于 ' + esc(fmtTime(t.updatedAt)) + '</span>';

    ticketSourceEl.innerHTML =
      '<h3>冻结来源（创建时的完整草稿，后续修改不会改写本证据单）</h3>' +
      '<div class="source-grid">' +
      '<span>容差：<strong>' + t.source.tolerance + '</strong></span>' +
      '<span>视野数：<strong>' + t.source.fieldCount + '</strong></span>' +
      '<span>观测数：<strong>' + t.source.observationCount + '</strong></span>' +
      '<span>最终颗粒：<strong>' + t.result.totalParticles + '</strong></span>' +
      '<span>采用关联：<strong>' + t.result.linkCount + '</strong></span>' +
      '<span>草稿指纹：<code>' + esc(t.source.draftHash.slice(0, 12)) + '</code></span>' +
      '</div>' +
      '<div class="source-fields">' + t.source.fields.map(function (f) {
        return '<span class="chip">' + esc(f.name) + '（平移 ' + f.offset.x + ', ' + f.offset.y + '，' + f.particleCount + ' 个观测）</span>';
      }).join('') + '</div>';

    var pct = p.total === 0 ? 100 : Math.round((p.confirmed / p.total) * 100);
    ticketProgressEl.innerHTML =
      '<div class="progress-text">复核进度：共 ' + p.total + ' 条采用关联，已确认 ' + p.confirmed +
      ' · 已否决 ' + p.rejected + ' · <strong>剩余 ' + p.remaining + '</strong></div>' +
      '<div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%"></div></div>';

    if (t.firstRejectedLinkIndex !== null) {
      var fl = t.links[t.firstRejectedLinkIndex];
      ticketFirstRejectedEl.innerHTML = '首条否决关联：#' + fl.index + '（' + esc(fl.a.particleId) + ' ↔ ' + esc(fl.b.particleId) +
        '，类别 ' + esc(fl.category) + '，坐标差 Δx=' + fl.dx + '、Δy=' + fl.dy + '）—— 该显微关联阻止本次颗粒计数被证实，需重新裁决。';
      ticketFirstRejectedEl.classList.remove('hidden');
    } else {
      ticketFirstRejectedEl.classList.add('hidden');
      ticketFirstRejectedEl.innerHTML = '';
    }

    if (t.links.length === 0) {
      ticketLinksEl.innerHTML = '<p class="hint">本次裁决无采用关联（全部颗粒独立），无需逐条复核。</p>';
    } else {
      ticketLinksEl.innerHTML = '<table class="link-table"><thead><tr>' +
        '<th>#</th><th>颗粒</th><th>类别</th><th>观测 A</th><th>观测 B</th><th>坐标差</th><th>复核结论</th>' +
        '</tr></thead><tbody>' + t.links.map(function (l) {
          var cur = openTicketState.decisions[l.index];
          var stateText = l.decision === 'pending' ? '待复核' : (l.decision === 'confirmed' ? '已确认' : '已否决');
          return '<tr class="link-row decision-' + esc(l.decision) + '">' +
            '<td>' + l.index + '</td>' +
            '<td>#' + l.particleId + '</td>' +
            '<td>' + esc(l.category) + '</td>' +
            '<td>' + obsText(l.a) + '</td>' +
            '<td>' + obsText(l.b) + '</td>' +
            '<td>Δx=' + l.dx + '<br>Δy=' + l.dy + '<br>曼哈顿=' + l.manhattan + '</td>' +
            '<td><div class="decision-cell">' +
              '<button type="button" class="small btn-confirm' + (cur === 'confirmed' ? ' active' : '') + '" data-action="decide" data-link="' + l.index + '" data-decision="confirmed">确认</button>' +
              '<button type="button" class="small btn-reject' + (cur === 'rejected' ? ' active' : '') + '" data-action="decide" data-link="' + l.index + '" data-decision="rejected">否决</button>' +
              '<span class="decision-state">' + stateText + '</span>' +
            '</div></td>' +
            '</tr>';
        }).join('') + '</tbody></table>';
    }

    if (t.status === 'verified') {
      reviewHint.textContent = '全部关联已确认，本次颗粒计数已证实。';
    } else if (t.status === 'needs-readjudication') {
      reviewHint.textContent = '存在否决关联，需重新裁决；可修正结论后再次提交。';
    }
  }

  // 逐条记录确认 / 否决（仅改本地待提交状态，提交后由服务端定论）
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-action="decide"]');
    if (!btn || !openTicketState) return;
    openTicketState.decisions[Number(btn.dataset.link)] = btn.dataset.decision;
    renderTicketDetail();
  });

  // 创建证据单：以裁决成功时的完整草稿调用服务端重新裁决并冻结
  document.getElementById('btn-create-ticket').addEventListener('click', function () {
    if (!lastAdjudicatedPayload) return;
    ticketCreateHint.textContent = '创建中…';
    fetchJson('/api/review-tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lastAdjudicatedPayload),
    })
      .then(function (r) {
        if (!r.res.ok) {
          var err = (r.body && r.body.error) || {};
          ticketCreateHint.textContent = err.message || ('创建失败（HTTP ' + r.res.status + '）');
          return;
        }
        ticketCreateHint.textContent = '已创建证据单 #' + r.body.id + '（结论与来源已冻结）。';
        loadTickets(r.body.id);
        document.getElementById('ticket-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      })
      .catch(function () {
        ticketCreateHint.textContent = '网络或服务器错误，创建失败。';
      });
  });

  document.getElementById('btn-refresh-tickets').addEventListener('click', function () {
    loadTickets(openTicketState ? openTicketState.ticket.id : null);
  });

  ticketListEl.addEventListener('click', function (e) {
    var item = e.target.closest('[data-ticket-id]');
    if (item) openTicket(Number(item.dataset.ticketId));
  });

  // 提交复核结论：携带当前版本与唯一操作号；冲突时刷新为最新证据单
  document.getElementById('btn-submit-review').addEventListener('click', function () {
    if (!openTicketState) return;
    var t = openTicketState.ticket;
    var decisions = Object.keys(openTicketState.decisions)
      .map(function (k) { return { linkIndex: Number(k), decision: openTicketState.decisions[k] }; })
      .sort(function (a, b) { return a.linkIndex - b.linkIndex; });
    if (decisions.length === 0) {
      reviewHint.textContent = '请先逐条确认或否决采用关联，再提交。';
      return;
    }
    var payload = { version: t.version, operationId: operationIdFor(t.id, t.version, decisions), decisions: decisions };
    reviewHint.textContent = '提交中…';
    fetchJson('/api/review-tickets/' + t.id + '/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) {
        if (r.res.ok) {
          openTicketState.ticket = r.body;
          syncDecisionsFromTicket();
          renderTicketDetail();
          reviewHint.textContent = '复核已提交（版本 v' + r.body.version + '）。' +
            (r.body.status === 'verified' ? '全部关联已确认，本次颗粒计数已证实。' : '');
          loadTickets();
          return;
        }
        var err = (r.body && r.body.error) || {};
        if (r.res.status === 409) {
          reviewHint.textContent = (err.message || '版本冲突') + ' 已为你刷新最新证据单。';
          openTicket(t.id); // 过期版本 / 操作号冲突：不改变证据单，刷新后重试
          return;
        }
        reviewHint.textContent = err.message || ('提交失败（HTTP ' + r.res.status + '）');
      })
      .catch(function () {
        // 网络失败：操作号由内容确定，直接重试即为幂等重试
        reviewHint.textContent = '网络或服务器错误，请直接重试（同一操作号不会产生重复记录）。';
      });
  });

  loadTickets();
  render();
})();
