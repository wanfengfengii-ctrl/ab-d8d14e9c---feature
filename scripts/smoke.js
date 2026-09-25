'use strict';

/**
 * API 冒烟验收：针对运行中的服务执行健康检查、页面可达性、
 * 去重裁决（含拒绝贪心的关键用例）、校验反馈与错误处理检查。
 * 既可被 verify 调用，也可独立运行：BASE_URL=http://host:port node scripts/smoke.js
 */

export async function runSmoke(base) {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail: detail || '' });
  };
  const post = (body, raw = false) => fetch(`${base}/api/particle-deduplications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? body : JSON.stringify(body),
  });

  // 1. 健康检查
  try {
    const res = await fetch(`${base}/api/health`);
    const body = await res.json();
    check('GET /api/health → 200 且 status=ok', res.status === 200 && body.status === 'ok', `HTTP ${res.status}`);
  } catch (err) {
    check('GET /api/health', false, String(err));
  }

  // 2. 前端页面
  try {
    const res = await fetch(`${base}/`);
    const html = await res.text();
    check('GET / → 200 且包含录入界面', res.status === 200 && html.includes('微塑料') && html.includes('app.js'), `HTTP ${res.status}`);
  } catch (err) {
    check('GET /', false, String(err));
  }

  // 3. 去重裁决：关键用例（局部贪心会得出 4 个颗粒，全局最优为 3 个）
  try {
    const res = await post({
      tolerance: 1,
      fields: [
        { name: 'F1', offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }, { id: 'A2', x: 2, y: 0, category: 'PE' }] },
        { name: 'F2', offset: { x: 0, y: 0 }, particles: [{ id: 'B1', x: 1, y: 0, category: 'PE' }, { id: 'B2', x: 0, y: 1, category: 'PE' }] },
        { name: 'F3', offset: { x: 100, y: 100 }, particles: [{ id: 'C1', x: 0, y: 0, category: 'PP' }] },
      ],
    });
    const body = await res.json();
    check('POST 裁决 → 200', res.status === 200, `HTTP ${res.status}`);
    check('最终颗粒总数为 3（拒绝贪心结果 4）', body.totalParticles === 3, `实际为 ${body.totalParticles}`);
    const groups = (body.particles || [])
      .map((p) => p.observations.map((o) => o.particleId).sort().join('+'))
      .sort();
    check('分组为 {A1,B2}、{A2,B1}、{C1}', JSON.stringify(groups) === JSON.stringify(['A1+B2', 'A2+B1', 'C1']), groups.join(' | '));
    const merged = (body.particles || []).find((p) => p.observations.some((o) => o.particleId === 'B2'));
    check(
      '代表坐标为质心 (0, 0.5) 且类别正确',
      !!merged && merged.representative.x === 0 && merged.representative.y === 0.5 && merged.category === 'PE',
      merged ? JSON.stringify(merged.representative) : '未找到颗粒',
    );
    const links = (body.particles || []).flatMap((p) => p.links.map((l) => [l.a, l.b].sort().join('~'))).sort();
    check('所选关联为 A1-B2、A2-B1', JSON.stringify(links) === JSON.stringify(['A1~B2', 'A2~B1']), links.join(' | '));
  } catch (err) {
    check('POST 裁决', false, String(err));
  }

  // 4. 校验反馈：可定位且保留草稿语义（400 + issues）
  try {
    const res = await post({
      tolerance: 1,
      fields: [
        { offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }] },
        { offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0.5, y: 0, category: '' }] },
      ],
    });
    const body = await res.json();
    const paths = (body.error && Array.isArray(body.error.issues)) ? body.error.issues.map((i) => i.path) : [];
    check('不合规输入 → 400', res.status === 400, `HTTP ${res.status}`);
    check(
      '反馈包含可定位路径',
      paths.includes('fields[1].particles[0].id') && paths.includes('fields[1].particles[0].x') && paths.includes('fields'),
      paths.join(' | '),
    );
  } catch (err) {
    check('校验反馈', false, String(err));
  }

  // 5. 非法 JSON
  try {
    const res = await post('{not valid json', true);
    check('非法 JSON → 400', res.status === 400, `HTTP ${res.status}`);
  } catch (err) {
    check('非法 JSON', false, String(err));
  }

  // 6. 未知接口
  try {
    const res = await fetch(`${base}/api/no-such-endpoint`);
    check('未知接口 → 404', res.status === 404, `HTTP ${res.status}`);
  } catch (err) {
    check('未知接口', false, String(err));
  }

  // 7. 复测证据单：创建 → 冻结 → 复核 → 幂等 → 否决转需重裁决
  try {
    const draft = {
      tolerance: 1,
      fields: [
        { name: 'F1', offset: { x: 0, y: 0 }, particles: [{ id: 'A1', x: 0, y: 0, category: 'PE' }, { id: 'A2', x: 2, y: 0, category: 'PE' }] },
        { name: 'F2', offset: { x: 0, y: 0 }, particles: [{ id: 'B1', x: 1, y: 0, category: 'PE' }, { id: 'B2', x: 0, y: 1, category: 'PE' }] },
        { name: 'F3', offset: { x: 100, y: 100 }, particles: [{ id: 'C1', x: 0, y: 0, category: 'PP' }] },
      ],
    };
    const createRes = await fetch(`${base}/api/review-evidence-sheets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    });
    const sheet = await createRes.json();
    check('创建证据单 → 201 且冻结来源与结论', createRes.status === 201
      && sheet.status === 'pending'
      && sheet.result && sheet.result.totalParticles === 3
      && sheet.source && typeof sheet.source.hash === 'string'
      && Array.isArray(sheet.links) && sheet.links.length === 2, `HTTP ${createRes.status}`);
    const sid = sheet.id;
    const linkOk = sheet.links.every((l) => l.a && l.b && l.category
      && l.dx === Math.abs(l.a.filterX - l.b.filterX)
      && l.dy === Math.abs(l.a.filterY - l.b.filterY));
    check('每条采用关联列出两端观测、类别与坐标差', linkOk);

    const review = (payload) => fetch(`${base}/api/review-evidence-sheets/${sid}/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const staleRes = await review({ version: 99, operationId: 'smoke-stale', decisions: [{ linkId: 1, decision: 'confirm' }] });
    check('过期版本 → 409 且证据单不变', staleRes.status === 409, `HTTP ${staleRes.status}`);

    const okRes = await review({ version: 0, operationId: 'smoke-op-1', decisions: [{ linkId: 1, decision: 'confirm' }] });
    const okBody = await okRes.json();
    check('确认关联 #1 → 200 且版本推进', okRes.status === 200 && okBody.version === 1 && okBody.progress.confirmed === 1, `HTTP ${okRes.status}`);

    const replayRes = await review({ version: 0, operationId: 'smoke-op-1', decisions: [{ linkId: 1, decision: 'confirm' }] });
    const replayBody = await replayRes.json();
    check('同操作号同内容重试 → 返回原结果', replayRes.status === 200 && replayBody.idempotentReplay === true && replayBody.version === 1, `HTTP ${replayRes.status}`);

    const conflictRes = await review({ version: 1, operationId: 'smoke-op-1', decisions: [{ linkId: 2, decision: 'reject' }] });
    check('同操作号不同内容 → 409 且证据单不变', conflictRes.status === 409, `HTTP ${conflictRes.status}`);

    const rejectRes = await review({ version: 1, operationId: 'smoke-op-2', decisions: [{ linkId: 2, decision: 'reject' }] });
    const rejectBody = await rejectRes.json();
    check('否决关联 #2 → 立即转为需重裁决并记录首条否决关联', rejectRes.status === 200
      && rejectBody.status === 'needs_readjudication'
      && rejectBody.firstRejectedLinkId === 2, `HTTP ${rejectRes.status}`);

    const closedRes = await review({ version: 2, operationId: 'smoke-op-3', decisions: [{ linkId: 2, decision: 'confirm' }] });
    check('终态后提交 → 409', closedRes.status === 409, `HTTP ${closedRes.status}`);

    const getRes = await fetch(`${base}/api/review-evidence-sheets/${sid}`);
    const got = await getRes.json();
    check('按编号获取证据单 → 冻结内容保持', getRes.status === 200 && got.version === 2 && got.result.totalParticles === 3, `HTTP ${getRes.status}`);

    const listRes = await fetch(`${base}/api/review-evidence-sheets`);
    const list = await listRes.json();
    check('证据单列表包含该单', listRes.status === 200 && list.sheets.some((s) => s.id === sid), `HTTP ${listRes.status}`);
  } catch (err) {
    check('复测证据单冒烟', false, String(err));
  }

  return results;
}

import { pathToFileURL } from 'node:url';

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const base = process.env.BASE_URL || 'http://127.0.0.1:8080';
  console.log(`[smoke] 目标服务: ${base}`);
  const results = await runSmoke(base);
  for (const r of results) {
    console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ` — ${r.detail}`}`);
  }
  const ok = results.every((r) => r.ok);
  console.log(ok ? '[smoke] 全部通过' : '[smoke] 存在失败项');
  process.exit(ok ? 0 : 1);
}
