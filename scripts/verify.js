'use strict';

/**
 * 一次性验收服务（docker compose 中的 verify）：
 *   1. 构建检查：对全部源码执行 node --check（本项目无编译期，语法检查即构建验证）；
 *   2. 单元测试：node --test 运行求解器 / 校验 / API / 证据单测试；
 *   3. API 冒烟验收：启动真实服务并执行 scripts/smoke.js 的验收项（含证据单业务 API）；
 *   4. 证据单重启恢复：同一数据目录先后启动两个服务实例，验证证据单按编号恢复。
 * 全部通过以退出码 0 结束，否则以退出码 1 结束。
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
const close = (server) => new Promise((resolve) => server.close(resolve));

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

// ── 步骤 3：API 冒烟验收（独立临时数据目录，不污染仓库） ──────────
{
  const dataDir = await mkdtemp(path.join(tmpdir(), 'evidence-smoke-'));
  const server = createServer({ dataDir });
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
    await rm(dataDir, { recursive: true, force: true });
  }
  record('API 冒烟验收', ok);
}

// ── 步骤 4：证据单重启恢复 ───────────────────────────────────────
{
  const dataDir = await mkdtemp(path.join(tmpdir(), 'evidence-restart-'));
  const draft = {
    tolerance: 1,
    fields: [
      { offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }, { id: 'A2', x: 2, y: 0, category: 'PE' }] },
      { offset: { x: 0, y: 0 }, particles: [{ id: 'B1', x: 1, y: 0, category: 'PE' }, { id: 'B2', x: 0, y: 1, category: 'PE' }] },
      { offset: { x: 100, y: 100 }, particles: [{ id: 'C1', x: 0, y: 0, category: 'PP' }] },
    ],
  };
  const post = (base, p, body) => fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let ok = true;
  const detail = [];
  try {
    // 第一次启动：创建证据单并提交一次复核
    const s1 = createServer({ dataDir });
    const base1 = await listen(s1);
    const created = await (await post(base1, '/api/review-evidence-sheets', draft)).json();
    const reviewed = await (await post(base1, `/api/review-evidence-sheets/${created.id}/reviews`, {
      version: 0,
      operationId: 'verify-restart-op',
      decisions: [{ linkId: 1, decision: 'confirm' }],
    })).json();
    await close(s1);
    ok = ok && created.id === 1 && reviewed.version === 1;
    detail.push(`首次启动：证据单 #${created.id} 版本 v${reviewed.version}`);

    // 模拟重启：同一数据目录启动新实例，按编号恢复
    const s2 = createServer({ dataDir });
    const base2 = await listen(s2);
    const res = await fetch(`${base2}/api/review-evidence-sheets/${created.id}`);
    const got = await res.json();
    const recovered = res.status === 200
      && got.version === 1
      && got.status === 'pending'
      && got.links[0].decision === 'confirmed'
      && got.result.totalParticles === 3
      && got.source.hash === created.source.hash;
    ok = ok && recovered;
    detail.push(recovered ? '重启后按编号恢复（版本 / 进度 / 冻结结论一致）' : `恢复失败: HTTP ${res.status}`);

    // 重启后复核可继续推进至已证实
    const done = await (await post(base2, `/api/review-evidence-sheets/${created.id}/reviews`, {
      version: 1,
      operationId: 'verify-restart-op-2',
      decisions: [{ linkId: 2, decision: 'confirm' }],
    })).json();
    ok = ok && done.status === 'verified';
    detail.push(done.status === 'verified' ? '重启后复核推进至已证实' : `推进失败: ${JSON.stringify(done.error || done)}`);
    await close(s2);
  } catch (err) {
    ok = false;
    detail.push(String(err && err.stack ? err.stack : err));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
  for (const d of detail) console.log(`  ${d}`);
  record('证据单重启恢复', ok);
}

const allOk = steps.every((s) => s.ok);
console.log('');
console.log(allOk ? '═══ 验收通过：构建、测试与 API 冒烟全部成功 ═══' : '═══ 验收未通过，请检查上述失败项 ═══');
process.exit(allOk ? 0 : 1);
