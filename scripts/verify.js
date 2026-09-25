'use strict';

/**
 * 一次性验收服务（docker compose 中的 verify）：
 *   1. 构建检查：对全部源码执行 node --check（本项目无编译期，语法检查即构建验证）；
 *   2. 单元测试：node --test 运行求解器 / 校验 / API / 证据单测试；
 *   3. API 冒烟验收：启动真实服务并执行 scripts/smoke.js 的验收项（含证据单业务 API）；
 *   4. 证据单重启恢复验收：同一数据目录重启服务后按编号恢复证据单与幂等台账。
 * 全部通过以退出码 0 结束，否则以退出码 1 结束。
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';
import { runSmoke } from './smoke.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const steps = [];
function record(name, ok, detail) {
  steps.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
function close(server) {
  return new Promise((resolve) => server.close(resolve));
}
const postJson = (url, body) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function listJsFiles(dir) {
  const abs = path.join(ROOT, dir);
  try {
    return readdirSync(abs)
      .filter((f) => f.endsWith('.js'))
      .map((f) => path.join(abs, f));
  } catch {
    return [];
  }
}

// ── 步骤 1：构建检查 ─────────────────────────────────────────────
{
  const files = [
    ...listJsFiles('src'),
    ...listJsFiles('scripts'),
    ...listJsFiles('test'),
    ...listJsFiles('public'),
  ];
  const failed = [];
  for (const file of files) {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (r.status !== 0) failed.push(`${path.relative(ROOT, file)}: ${(r.stderr || '').trim().split('\n')[0]}`);
  }
  record(`构建检查（node --check，共 ${files.length} 个文件）`, failed.length === 0, failed.join('；'));
}

// ── 步骤 2：单元测试 ─────────────────────────────────────────────
{
  const r = spawnSync(process.execPath, ['--test'], { cwd: ROOT, encoding: 'utf8' });
  const ok = r.status === 0;
  record('单元测试（node --test）', ok);
  if (!ok) {
    const out = `${r.stdout || ''}\n${r.stderr || ''}`.trim().split('\n');
    console.log(out.slice(-40).join('\n'));
  }
}

// ── 步骤 3：API 冒烟验收 ─────────────────────────────────────────
{
  const smokeDataDir = mkdtempSync(path.join(os.tmpdir(), 'dedup-smoke-data-'));
  const server = createServer({ dataDir: smokeDataDir });
  const base = await listen(server);
  console.log(`  冒烟验收目标: ${base}（verify 内部启动的真实服务）`);
  let ok = true;
  try {
    const results = await runSmoke(base);
    for (const r of results) {
      console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ` — ${r.detail}`}`);
      if (!r.ok) ok = false;
    }
  } catch (err) {
    ok = false;
    console.log(`  ✗ 冒烟验收异常: ${err && err.stack ? err.stack : err}`);
  } finally {
    await close(server);
    rmSync(smokeDataDir, { recursive: true, force: true });
  }
  record('API 冒烟验收', ok);
}

// ── 步骤 4：证据单重启恢复验收 ────────────────────────────────────
{
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'dedup-restart-data-'));
  const details = [];
  let ok = true;
  const expect = (cond, label) => {
    if (!cond) { ok = false; details.push(`未通过：${label}`); }
  };
  try {
    const draft = {
      tolerance: 1,
      fields: [
        { name: 'F1', offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }, { id: 'A2', x: 2, y: 0, category: 'PE' }] },
        { name: 'F2', offset: { x: 0, y: 0 }, particles: [{ id: 'B1', x: 1, y: 0, category: 'PE' }, { id: 'B2', x: 0, y: 1, category: 'PE' }] },
        { name: 'F3', offset: { x: 100, y: 100 }, particles: [{ id: 'C1', x: 0, y: 0, category: 'PP' }] },
      ],
    };

    // 第一次启动：创建证据单并提交一条复核结论
    let server = createServer({ dataDir });
    let base = await listen(server);
    const ticket = await (await postJson(`${base}/api/review-tickets`, draft)).json();
    const reviewPayload = {
      version: ticket.version,
      operationId: 'verify-restart-op',
      decisions: [{ linkIndex: 0, decision: 'confirmed' }, { linkIndex: 1, decision: 'rejected' }],
    };
    const reviewed = await (await postJson(`${base}/api/review-tickets/${ticket.id}/reviews`, reviewPayload)).json();
    expect(reviewed.status === 'needs-readjudication' && reviewed.version === 1, '重启前复核已应用');
    await close(server);

    // 第二次启动（同一数据目录）：按编号恢复
    server = createServer({ dataDir });
    base = await listen(server);
    const restoredRes = await fetch(`${base}/api/review-tickets/${ticket.id}`);
    const restored = await restoredRes.json();
    expect(restoredRes.status === 200, '重启后按编号 GET 证据单 → 200');
    expect(restored.version === 1 && restored.status === 'needs-readjudication', '重启后版本与状态恢复');
    expect(restored.links[0].decision === 'confirmed' && restored.links[1].decision === 'rejected', '重启后逐条复核结论恢复');
    expect(restored.firstRejectedLinkIndex === 1, '重启后首条否决关联恢复');
    expect(restored.result.totalParticles === 3 && restored.source.observationCount === 5, '重启后冻结结论与来源摘要不变');
    const list = await (await fetch(`${base}/api/review-tickets`)).json();
    expect(list.tickets.some((x) => x.id === ticket.id), '重启后列表包含该证据单');
    // 幂等台账同样恢复：同操作号同内容返回原结果
    const replay = await postJson(`${base}/api/review-tickets/${ticket.id}/reviews`, reviewPayload);
    const replayBody = await replay.json();
    expect(replay.status === 200 && replayBody.version === 1, '重启后同操作号同内容重试返回原结果');
    // 编号不回退
    const next = await (await postJson(`${base}/api/review-tickets`, draft)).json();
    expect(next.id > ticket.id, '重启后证据单编号单调递增');
    await close(server);
  } catch (err) {
    ok = false;
    details.push(String(err && err.stack ? err.stack : err));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
  record('证据单重启恢复验收', ok, details.join('；'));
}

const allOk = steps.every((s) => s.ok);
console.log('');
console.log(allOk ? '═══ 验收通过：构建、测试与 API 冒烟全部成功 ═══' : '═══ 验收未通过，请检查上述失败项 ═══');
process.exit(allOk ? 0 : 1);
