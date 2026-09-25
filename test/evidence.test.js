'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';

/** 含两条采用关联的示例草稿（全局最优 3 个最终颗粒、2 条关联）。 */
const SAMPLE_DRAFT = {
  tolerance: 1,
  fields: [
    { name: 'F1', offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }, { id: 'A2', x: 2, y: 0, category: 'PE' }] },
    { name: 'F2', offset: { x: 0, y: 0 }, particles: [{ id: 'B1', x: 1, y: 0, category: 'PE' }, { id: 'B2', x: 0, y: 1, category: 'PE' }] },
    { name: 'F3', offset: { x: 100, y: 100 }, particles: [{ id: 'C1', x: 0, y: 0, category: 'PP' }] },
  ],
};

/** 零关联草稿（各类别互不相同且距离远）。 */
const NO_LINK_DRAFT = {
  tolerance: 0,
  fields: [
    { offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }] },
    { offset: { x: 500, y: 0 }, particles: [{ id: 'B1', x: 0, y: 0, category: 'PP' }] },
    { offset: { x: 0, y: 500 }, particles: [{ id: 'C1', x: 0, y: 0, category: 'PET' }] },
  ],
};

async function startServer(dataDir) {
  const server = createServer({ dataDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const closeServer = (server) => new Promise((resolve) => server.close(resolve));

async function createSheet(base, draft = SAMPLE_DRAFT) {
  const res = await fetch(`${base}/api/review-evidence-sheets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  });
  return { res, body: await res.json() };
}

async function getSheet(base, id) {
  const res = await fetch(`${base}/api/review-evidence-sheets/${id}`);
  return { res, body: await res.json() };
}

async function postReview(base, id, payload) {
  const res = await fetch(`${base}/api/review-evidence-sheets/${id}/reviews`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { res, body: await res.json() };
}

test('创建证据单：服务端重新裁决并冻结来源、最终颗粒与采用关联', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'evidence-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { server, base } = await startServer(dir);
  t.after(() => closeServer(server));

  const { res, body } = await createSheet(base);
  assert.equal(res.status, 201);
  assert.equal(body.id, 1);
  assert.equal(body.version, 0);
  assert.equal(body.status, 'pending');

  // 冻结来源摘要
  assert.equal(body.source.tolerance, 1);
  assert.equal(body.source.fieldCount, 3);
  assert.equal(body.source.observationCount, 5);
  assert.equal(body.source.fields.length, 3);
  assert.match(body.source.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(body.source.draft.fields[0].name, 'F1'); // 完整草稿被冻结

  // 冻结裁决结果（重新裁决，与去重接口一致）
  assert.equal(body.result.totalParticles, 3);
  assert.equal(body.result.linkCount, 2);

  // 每条采用关联：两端观测、类别、坐标差
  assert.equal(body.links.length, 2);
  const l1 = body.links[0];
  assert.equal(l1.linkId, 1);
  assert.equal(l1.category, 'PE');
  assert.equal(l1.decision, null);
  assert.ok(l1.a.particleId && l1.b.particleId);
  assert.equal(typeof l1.a.filterX, 'number');
  assert.equal(l1.dx, Math.abs(l1.a.filterX - l1.b.filterX));
  assert.equal(l1.dy, Math.abs(l1.a.filterY - l1.b.filterY));
  assert.equal(l1.manhattan, l1.dx + l1.dy);

  // 进度与首条否决关联
  assert.deepEqual(body.progress, { total: 2, confirmed: 0, rejected: 0, remaining: 2 });
  assert.equal(body.firstRejectedLinkId, null);
});

test('创建证据单：草稿不合规返回 400 与可定位问题', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'evidence-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { server, base } = await startServer(dir);
  t.after(() => closeServer(server));

  const { res, body } = await createSheet(base, { tolerance: -1, fields: [] });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(body.error.issues));
  assert.ok(body.error.issues.some((i) => i.path === 'tolerance'));
});

test('复核流程：确认与否决、版本与操作号幂等、终态锁定', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'evidence-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { server, base } = await startServer(dir);
  t.after(() => closeServer(server));

  const created = await createSheet(base);
  const id = created.body.id;

  // 过期版本 → 409，证据单不变
  const stale = await postReview(base, id, { version: 7, operationId: 'op-stale', decisions: [{ linkId: 1, decision: 'confirm' }] });
  assert.equal(stale.res.status, 409);
  assert.equal(stale.body.error.code, 'STALE_VERSION');
  assert.equal(stale.body.error.currentVersion, 0);
  let current = await getSheet(base, id);
  assert.equal(current.body.version, 0);
  assert.equal(current.body.progress.confirmed, 0);

  // 正常确认关联 #1
  const ok1 = await postReview(base, id, { version: 0, operationId: 'op-1', decisions: [{ linkId: 1, decision: 'confirm' }] });
  assert.equal(ok1.res.status, 200);
  assert.equal(ok1.body.version, 1);
  assert.equal(ok1.body.idempotentReplay, false);
  assert.equal(ok1.body.links[0].decision, 'confirmed');
  assert.deepEqual(ok1.body.progress, { total: 2, confirmed: 1, rejected: 0, remaining: 1 });

  // 同操作号同内容重试 → 返回原结果（幂等重放），证据单不变
  const replay = await postReview(base, id, { version: 0, operationId: 'op-1', decisions: [{ linkId: 1, decision: 'confirm' }] });
  assert.equal(replay.res.status, 200);
  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(replay.body.version, 1);
  current = await getSheet(base, id);
  assert.equal(current.body.version, 1);

  // 同操作号不同内容 → 409，证据单不变
  const conflict = await postReview(base, id, { version: 1, operationId: 'op-1', decisions: [{ linkId: 2, decision: 'reject' }] });
  assert.equal(conflict.res.status, 409);
  assert.equal(conflict.body.error.code, 'OPERATION_CONFLICT');
  current = await getSheet(base, id);
  assert.equal(current.body.version, 1);
  assert.equal(current.body.links[1].decision, null);

  // 重复判定已决关联 → 409
  const dup = await postReview(base, id, { version: 1, operationId: 'op-2', decisions: [{ linkId: 1, decision: 'reject' }] });
  assert.equal(dup.res.status, 409);
  assert.equal(dup.body.error.code, 'LINK_ALREADY_DECIDED');

  // 否决关联 #2 → 立即转为需重裁决，首条否决关联被记录
  const reject = await postReview(base, id, { version: 1, operationId: 'op-3', decisions: [{ linkId: 2, decision: 'reject' }] });
  assert.equal(reject.res.status, 200);
  assert.equal(reject.body.status, 'needs_readjudication');
  assert.equal(reject.body.firstRejectedLinkId, 2);
  assert.equal(reject.body.links[1].decision, 'rejected');

  // 终态后任何提交 → 409，证据单不变
  const closed = await postReview(base, id, { version: 2, operationId: 'op-4', decisions: [{ linkId: 2, decision: 'confirm' }] });
  assert.equal(closed.res.status, 409);
  assert.equal(closed.body.error.code, 'SHEET_CLOSED');
  current = await getSheet(base, id);
  assert.equal(current.body.version, 2);
  assert.equal(current.body.status, 'needs_readjudication');
});

test('全部关联确认后标记为已证实', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'evidence-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { server, base } = await startServer(dir);
  t.after(() => closeServer(server));

  const created = await createSheet(base);
  const id = created.body.id;
  const done = await postReview(base, id, {
    version: 0,
    operationId: 'op-all',
    decisions: [
      { linkId: 1, decision: 'confirm' },
      { linkId: 2, decision: 'confirm' },
    ],
  });
  assert.equal(done.res.status, 200);
  assert.equal(done.body.status, 'verified');
  assert.deepEqual(done.body.progress, { total: 2, confirmed: 2, rejected: 0, remaining: 0 });
});

test('零关联裁决创建即为已证实', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'evidence-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { server, base } = await startServer(dir);
  t.after(() => closeServer(server));

  const { res, body } = await createSheet(base, NO_LINK_DRAFT);
  assert.equal(res.status, 201);
  assert.equal(body.links.length, 0);
  assert.equal(body.status, 'verified');
});

test('复核提交体形校验：400 与可定位问题', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'evidence-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { server, base } = await startServer(dir);
  t.after(() => closeServer(server));

  const created = await createSheet(base);
  const id = created.body.id;

  const bad = await postReview(base, id, {
    version: '0',
    decisions: [
      { linkId: 1, decision: 'maybe' },
      { linkId: 1, decision: 'confirm' },
      { linkId: -2, decision: 'confirm' },
    ],
  });
  assert.equal(bad.res.status, 400);
  const paths = bad.body.error.issues.map((i) => i.path);
  assert.ok(paths.includes('version'));
  assert.ok(paths.includes('operationId'));
  assert.ok(paths.includes('decisions[0].decision'));
  assert.ok(paths.includes('decisions[1].linkId')); // 重复 linkId
  assert.ok(paths.includes('decisions[2].linkId')); // 非法 linkId

  // 不存在的关联 → 400 UNKNOWN_LINK，证据单不变
  const unknown = await postReview(base, id, { version: 0, operationId: 'op-x', decisions: [{ linkId: 99, decision: 'confirm' }] });
  assert.equal(unknown.res.status, 400);
  assert.equal(unknown.body.error.code, 'UNKNOWN_LINK');
  const current = await getSheet(base, id);
  assert.equal(current.body.version, 0);

  // 不存在的证据单 → 404
  const missing = await postReview(base, 999, { version: 0, operationId: 'op-x', decisions: [{ linkId: 1, decision: 'confirm' }] });
  assert.equal(missing.res.status, 404);
  const missingGet = await getSheet(base, 999);
  assert.equal(missingGet.res.status, 404);
});

test('证据单在服务重启后按编号恢复（含复核进度与冻结结论）', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'evidence-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // 第一次启动：创建证据单并提交一次复核
  const first = await startServer(dir);
  const created = await createSheet(first.base);
  assert.equal(created.res.status, 201);
  const id = created.body.id;
  const review = await postReview(first.base, id, { version: 0, operationId: 'op-boot', decisions: [{ linkId: 1, decision: 'confirm' }] });
  assert.equal(review.res.status, 200);
  const second = await createSheet(first.base, NO_LINK_DRAFT); // 第二份证据单验证编号单调
  assert.equal(second.body.id, id + 1);
  await closeServer(first.server);

  // 模拟重启：同一数据目录启动新服务
  const restarted = await startServer(dir);
  t.after(() => closeServer(restarted.server));

  const got = await getSheet(restarted.base, id);
  assert.equal(got.res.status, 200);
  assert.equal(got.body.version, 1);
  assert.equal(got.body.status, 'pending');
  assert.equal(got.body.links[0].decision, 'confirmed');
  assert.equal(got.body.result.totalParticles, 3); // 冻结结论完好
  assert.equal(got.body.source.hash, created.body.source.hash);

  // 列表按编号恢复全部证据单
  const list = await fetch(`${restarted.base}/api/review-evidence-sheets`).then((r) => r.json());
  assert.deepEqual(list.sheets.map((s) => s.id), [id, id + 1]);
  assert.equal(list.sheets[1].status, 'verified');

  // 重启后幂等日志仍在：同操作号同内容重试返回原结果
  const replay = await postReview(restarted.base, id, { version: 0, operationId: 'op-boot', decisions: [{ linkId: 1, decision: 'confirm' }] });
  assert.equal(replay.res.status, 200);
  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(replay.body.version, 1);

  // 重启后复核可继续推进
  const next = await postReview(restarted.base, id, { version: 1, operationId: 'op-after-restart', decisions: [{ linkId: 2, decision: 'confirm' }] });
  assert.equal(next.res.status, 200);
  assert.equal(next.body.status, 'verified');
});

test('草稿后续修改不改写既有证据单', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'evidence-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { server, base } = await startServer(dir);
  t.after(() => closeServer(server));

  const created = await createSheet(base);
  const id = created.body.id;
  const frozenHash = created.body.source.hash;
  const frozenParticles = created.body.result.totalParticles;

  // 用另一份草稿再次裁决 / 创建新证据单
  await createSheet(base, NO_LINK_DRAFT);

  const got = await getSheet(base, id);
  assert.equal(got.body.source.hash, frozenHash);
  assert.equal(got.body.result.totalParticles, frozenParticles);
  assert.equal(got.body.source.tolerance, 1);
});
