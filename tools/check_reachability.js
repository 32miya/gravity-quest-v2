#!/usr/bin/env node
// 到達可能性チェッカー: 各マップの入口(他マップのexitsが指す着地点)から
// BFSで到達可能なタイル集合を求め、npcs(NPC/宝箱/オブジェクト)が
// 少なくとも1つの隣接マス経由で到達可能か検証する。
//
// 使い方:
//   node check_reachability.js                  # 全マップ
//   node check_reachability.js map_sage_shrine map_shrine_warp map_shrine_backroom
//
// 注意: 「撃破しないと消えない」ゲートNPC等は自動除外していない。
// 出力を見て、意図的なゲート（ボス/イベント条件）は目視で除外すること。

const { chromium } = require('playwright');

const GAME_URL = 'http://localhost:8765';
const ONLY_MAPS = process.argv.slice(2);

// index.html:9301 のリテラルと同一（フィールドは船あり=最も緩い判定を使う。
// 船が必要な到達は「意図的なゲート」であってバグではないため）
const INDOOR_SOLID = new Set([1, 2, 4, 5, 15, 16, 17, 18, 19, 20, 25, 26]);
const FIELD_SOLID_WITH_SHIP = new Set([1, 2, 4, 15, 16, 17, 18, 25, 26]);
// index.html:9303 の装飾ラグ(通行可)以外のnpcはタイルを塞ぐ
const PASSABLE_NPC_IDS = new Set(['obj_deco_rug_red', 'obj_deco_rug_blue', 'deco_rug_gold', 'obj_deco_rug_yellow']);

function isFieldMap(mapId) {
  return /^map_field_/.test(mapId) || /^map_ocean_/.test(mapId);
}

function buildEntrances(externalMapData) {
  const entrances = {}; // mapId -> [{x,y}]
  for (const [srcId, m] of Object.entries(externalMapData)) {
    if (!m || !m.exits) continue;
    for (const ev of Object.values(m.exits)) {
      if (!ev || !ev.map) continue;
      let destId = ev.map;
      if (!externalMapData[destId] && externalMapData['map_' + destId]) destId = 'map_' + destId;
      if (!externalMapData[destId]) continue;
      (entrances[destId] = entrances[destId] || []).push({ x: ev.x, y: ev.y });
    }
  }
  return entrances;
}

function bfsReachable(map, mapId, starts) {
  const W = map.width, H = map.height;
  const solid = isFieldMap(mapId) ? FIELD_SOLID_WITH_SHIP : INDOOR_SOLID;
  const blocked = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return true;
    const t = map.tiles[y * W + x];
    if (solid.has(t)) return true;
    const npc = map.npcs && map.npcs[`${x},${y}`];
    if (npc && !PASSABLE_NPC_IDS.has(npc.id)) return true;
    return false;
  };
  // 同一マップ内を指すexits(ワープパッド等)は追加の移動エッジとして扱う
  const teleports = {}; // "x,y" -> [{x,y}, ...]
  for (const [key, ev] of Object.entries(map.exits || {})) {
    if (!ev || ev.map !== mapId || ev.x == null || ev.y == null) continue;
    (teleports[key] = teleports[key] || []).push({ x: ev.x, y: ev.y });
  }
  const seen = new Set();
  const q = [];
  for (const s of starts) {
    if (s.x == null || s.y == null) continue;
    const k = `${s.x},${s.y}`;
    if (!seen.has(k)) { seen.add(k); q.push([s.x, s.y]); } // 入口タイル自体は起点として許容
  }
  let head = 0;
  while (head < q.length) {
    const [x, y] = q[head++];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      const k = `${nx},${ny}`;
      if (seen.has(k) || blocked(nx, ny)) continue;
      seen.add(k);
      q.push([nx, ny]);
    }
    const tp = teleports[`${x},${y}`];
    if (tp) for (const d of tp) {
      const k = `${d.x},${d.y}`;
      if (seen.has(k)) continue;
      seen.add(k);
      q.push([d.x, d.y]);
    }
  }
  return seen;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => typeof _loadPct !== 'undefined' && _loadPct >= 100, { timeout: 60000 });
  const externalMapData = await page.evaluate(() => externalMapData);
  await browser.close();

  const mapIds = ONLY_MAPS.length ? ONLY_MAPS : Object.keys(externalMapData);
  const entrances = buildEntrances(externalMapData);

  let totalFail = 0, totalChecked = 0;
  const failures = [];

  for (const mapId of mapIds) {
    const map = externalMapData[mapId];
    if (!map || !map.tiles) { console.log(`[SKIP] ${mapId} (マップデータなし)`); continue; }
    const starts = entrances[mapId] || [];
    if (!starts.length) { console.log(`[SKIP] ${mapId} (入口不明: 他マップのexitsから参照なし)`); continue; }
    const reach = bfsReachable(map, mapId, starts);

    for (const [key, npc] of Object.entries(map.npcs || {})) {
      totalChecked++;
      const [x, y] = key.split(',').map(Number);
      if (PASSABLE_NPC_IDS.has(npc.id)) continue;
      const neighbors = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => `${x + dx},${y + dy}`);
      const okDirect = reach.has(key); // 通行可能タイルに直接NPCが立っている特殊ケース
      const okAdjacent = neighbors.some(k => reach.has(k));
      if (!okDirect && !okAdjacent) {
        totalFail++;
        failures.push({ mapId, npcId: npc.id, name: npc.name, x, y });
      }
    }
  }

  console.log('\n=== 到達可能性チェック結果 ===');
  console.log(`検査対象NPC/オブジェクト: ${totalChecked}件 / 未到達: ${totalFail}件\n`);
  if (failures.length) {
    console.log('map,npcId,name,x,y');
    for (const f of failures) console.log(`${f.mapId},${f.npcId},${f.name || ''},${f.x},${f.y}`);
  } else {
    console.log('未到達のNPC/オブジェクトは検出されませんでした。');
  }
})().catch(e => { console.error(e); process.exit(1); });
