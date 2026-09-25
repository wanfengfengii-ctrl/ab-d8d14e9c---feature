'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { solveDeduplication } from '../src/dedup.js';
import { validateSubmission } from '../src/validation.js';

/** 关键用例：2 条采用关联（A1-B2、A2-B1），3 个最终颗粒。 */
function sampleDraft() {
  return {
    tolerance: 1,
    fields: [
      { name: 'F1', offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }, { id: 'A2', x: 2, y: 0, category: 'PE' }] },
      { name: 'F2', offset: { x: 0, y: 0 }, particles: [{ id: 'B1', x: 1, y: 0, category: 'PE' }, { id: 'B2', x: 0, y: 1, category: 'PE' }] },
      { name: 'F3', offset: { x: 100, y: 100 }, particles: [{ id: 'C1', x: 0, y: 0, category: 'PP' }] },
    ],
  };
}

const tmpDirs = [];
const servers = [];

function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-review-test-'));
  tmpDirs.push(dir);
  return dir;
}

async function startServer(dataDir) {
  const server = createServer({ dataDir: dataDir || makeDataDir() });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

test.after(() => {
  for (const s of servers) s.close();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

const postJson = (url, body) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const createTicket = (base, draft) => postJson(`${base}/api/review-tickets`, draft || sampleDraft());
const review = (base, id, payload) => postJson(`${base}/api/review-tickets/${id}/reviews`, payload);
const getTicket = (base, id) => fetch(`${base}/api/review-tickets/${id}`);

test('创建证据单：服务端重新裁决并冻结最终颗粒、采用关联与来源摘要', async () => {
  const base = await startServer();
  const res = await createTicket(base);
  assert.equal(res.status, 201);
  const t = await res.json();

  assert.equal(t.version, 0);
  assert.equal(t.status, 'pending');
  // 冻结的裁决结果与直接求解一致
  const expected = solveDeduplication(validateSubmission(sampleDraft()).value);
  assert.deepEqual(t.result, expected);
  // 来源摘要
  assert.equal(t.source.tolerance, 1);
  assert.equal(t.source.fieldCount, 3);
  assert.equal(t.source.observationCount, 5);
  assert.equal(t.source.fields.length, 3);
  assert.equal(typeof t.source.draftHash, 'string');
  // 采用关联：两端观测、类别与坐标差
  assert.equal(t.links.length, 2);
  const l0 = t.links[0];
  assert.equal(l0.category, 'PE');
  assert.equal(l0.a.particleId, 'A1');
  assert.equal(l0.b.particleId, 'B2');
  assert.equal(l0.dx, 0);
  assert.equal(l0.dy, 1);
  assert.equal(l0.manhattan, 1);
  assert.equal(l0.decision, 'pending');
  assert.equal(t.progress.total, 2);
  assert.equal(t.progress.remaining, 2);
  assert.equal(t.firstRejectedLinkIndex, null);
});

test('创建不合规草稿返回 400，未知证据单返回 404', async () => {
  const base = await startServer();
  const bad = await postJson(`${base}/api/review-tickets`, { tolerance: -1, fields: [] });
  assert.equal(bad.status, 400);
  assert.ok((await bad.json()).error.issues.length > 0);

  assert.equal((await getTicket(base, 999)).status, 404);
  const r = await review(base, 999, { version: 0, operationId: 'x', decisions: [{ linkIndex: 0, decision: 'confirmed' }] });
  assert.equal(r.status, 404);
});

test('全部关联确认后标记为已证实', async () => {
  const base = await startServer();
  const t = await (await createTicket(base)).json();
  const res = await review(base, t.id, {
    version: 0,
    operationId: 'op-confirm-all',
    decisions: [
      { linkIndex: 0, decision: 'confirmed' },
      { linkIndex: 1, decision: 'confirmed' },
    ],
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'verified');
  assert.equal(body.version, 1);
  assert.equal(body.progress.confirmed, 2);
  assert.equal(body.progress.remaining, 0);
});

test('任一否决立即转为需重裁决，首条否决关联可见；修正后可重新证实', async () => {
  const base = await startServer();
  const t = await (await createTicket(base)).json();
  const res = await review(base, t.id, {
    version: 0,
    operationId: 'op-reject',
    decisions: [{ linkIndex: 1, decision: 'rejected' }],
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'needs-readjudication');
  assert.equal(body.firstRejectedLinkIndex, 1);
  assert.equal(body.links[1].decision, 'rejected');
  assert.equal(body.links[1].decidedAt !== null, true);

  // 复核员修正结论：确认全部关联 → 已证实
  const fix = await review(base, t.id, {
    version: 1,
    operationId: 'op-fix',
    decisions: [
      { linkIndex: 0, decision: 'confirmed' },
      { linkIndex: 1, decision: 'confirmed' },
    ],
  });
  const fixed = await fix.json();
  assert.equal(fixed.status, 'verified');
  assert.equal(fixed.firstRejectedLinkIndex, null);
});

test('同内容重试返回原结果（幂等），版本不再前进', async () => {
  const base = await startServer();
  const t = await (await createTicket(base)).json();
  const payload = {
    version: 0,
    operationId: 'op-idempotent',
    decisions: [{ linkIndex: 0, decision: 'confirmed' }],
  };
  const first = await (await review(base, t.id, payload)).json();
  assert.equal(first.version, 1);
  const retryRes = await review(base, t.id, payload);
  assert.equal(retryRes.status, 200);
  const retry = await retryRes.json();
  assert.deepEqual(retry, first); // 原结果
  // 证据单未因重试而变化
  const current = await (await getTicket(base, t.id)).json();
  assert.equal(current.version, 1);
  assert.equal(current.links[1].decision, 'pending');
});

test('相同操作号的不同内容被拒绝（409）且证据单不变', async () => {
  const base = await startServer();
  const t = await (await createTicket(base)).json();
  await (await review(base, t.id, {
    version: 0,
    operationId: 'op-reuse',
    decisions: [{ linkIndex: 0, decision: 'confirmed' }],
  })).json();
  const conflict = await review(base, t.id, {
    version: 1,
    operationId: 'op-reuse',
    decisions: [{ linkIndex: 0, decision: 'rejected' }],
  });
  assert.equal(conflict.status, 409);
  const err = await conflict.json();
  assert.equal(err.error.code, 'OPERATION_CONFLICT');
  const current = await (await getTicket(base, t.id)).json();
  assert.equal(current.version, 1);
  assert.equal(current.links[0].decision, 'confirmed'); // 未被改写
  assert.equal(current.status, 'pending');
});

test('过期版本被拒绝（409）且证据单不变', async () => {
  const base = await startServer();
  const t = await (await createTicket(base)).json();
  await (await review(base, t.id, {
    version: 0,
    operationId: 'op-first',
    decisions: [{ linkIndex: 0, decision: 'confirmed' }],
  })).json();
  const stale = await review(base, t.id, {
    version: 0, // 已过期
    operationId: 'op-stale',
    decisions: [{ linkIndex: 1, decision: 'rejected' }],
  });
  assert.equal(stale.status, 409);
  const err = await stale.json();
  assert.equal(err.error.code, 'VERSION_CONFLICT');
  assert.equal(err.error.currentVersion, 1);
  const current = await (await getTicket(base, t.id)).json();
  assert.equal(current.version, 1);
  assert.equal(current.links[1].decision, 'pending');
});

test('复核提交不合规返回 400 且证据单不变', async () => {
  const base = await startServer();
  const t = await (await createTicket(base)).json();
  const cases = [
    { version: 0, operationId: 'op', decisions: [{ linkIndex: 0, decision: 'maybe' }] }, // 非法结论
    { version: 0, operationId: 'op', decisions: [{ linkIndex: 9, decision: 'confirmed' }] }, // 越界
    { version: 0, operationId: 'op', decisions: [] }, // 空提交
    { version: 0, operationId: 'op' }, // 缺 decisions
    { version: 0, decisions: [{ linkIndex: 0, decision: 'confirmed' }] }, // 缺操作号
    { operationId: 'op', decisions: [{ linkIndex: 0, decision: 'confirmed' }] }, // 缺版本
    { version: 0, operationId: 'op', decisions: [{ linkIndex: 0, decision: 'confirmed' }, { linkIndex: 0, decision: 'rejected' }] }, // 重复关联
  ];
  for (const body of cases) {
    const res = await review(base, t.id, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok((await res.json()).error.issues.length > 0);
  }
  const current = await (await getTicket(base, t.id)).json();
  assert.equal(current.version, 0);
  assert.equal(current.status, 'pending');
});

test('创建与每次提交后均可按编号在服务重启后恢复', async () => {
  const dir = makeDataDir();
  const base1 = await startServer(dir);
  const t = await (await createTicket(base1)).json();
  await (await review(base1, t.id, {
    version: 0,
    operationId: 'op-before-restart',
    decisions: [{ linkIndex: 0, decision: 'confirmed' }, { linkIndex: 1, decision: 'rejected' }],
  })).json();

  // 模拟重启：关闭全部监听后，用同一数据目录启动新服务
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  const base2 = await startServer(dir);

  const restored = await (await getTicket(base2, t.id)).json();
  assert.equal(restored.id, t.id);
  assert.equal(restored.version, 1);
  assert.equal(restored.status, 'needs-readjudication');
  assert.equal(restored.firstRejectedLinkIndex, 1);
  assert.equal(restored.links[0].decision, 'confirmed');
  assert.equal(restored.links[1].decision, 'rejected');
  assert.equal(restored.result.totalParticles, 3); // 冻结结论不变
  assert.equal(restored.source.observationCount, 5);

  // 列表同样恢复
  const list = await (await fetch(`${base2}/api/review-tickets`)).json();
  assert.ok(list.tickets.some((x) => x.id === t.id));

  // 重启后编号不回退：新证据单获得更大编号
  const t2 = await (await createTicket(base2)).json();
  assert.ok(t2.id > t.id);

  // 重启后幂等台账仍有效：同操作号同内容返回原结果
  const replay = await review(base2, t.id, {
    version: 0,
    operationId: 'op-before-restart',
    decisions: [{ linkIndex: 0, decision: 'confirmed' }, { linkIndex: 1, decision: 'rejected' }],
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).version, 1);
});

test('当前草稿的修改不改写既有证据单', async () => {
  const base = await startServer();
  const t = await (await createTicket(base)).json();

  // 草稿随后被修改并再次裁决 / 建立新证据单
  const changed = sampleDraft();
  changed.tolerance = 0;
  changed.fields[2].particles.push({ id: 'C2', x: 5, y: 5, category: 'PET' });
  await postJson(`${base}/api/particle-deduplications`, changed);
  const t2 = await (await createTicket(base, changed)).json();
  assert.notEqual(t2.id, t.id);

  // 原证据单保持冻结
  const original = await (await getTicket(base, t.id)).json();
  assert.equal(original.source.tolerance, 1);
  assert.equal(original.source.observationCount, 5);
  assert.equal(original.result.totalParticles, 3);
  assert.equal(original.links.length, 2);
});

test('无采用关联的证据单创建即为已证实', async () => {
  const base = await startServer();
  const res = await postJson(`${base}/api/review-tickets`, {
    tolerance: 0,
    fields: [
      { offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }] },
      { offset: { x: 0, y: 0 }, particles: [{ id: 'B1', x: 9, y: 9, category: 'PP' }] },
      { offset: { x: 0, y: 0 }, particles: [{ id: 'C1', x: 5, y: 5, category: 'PET' }] },
    ],
  });
  assert.equal(res.status, 201);
  const t = await res.json();
  assert.equal(t.links.length, 0);
  assert.equal(t.status, 'verified');
  assert.equal(t.progress.total, 0);
});
