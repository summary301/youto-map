/* 東京23区 用途地域マップ
 *
 * データは build/build_site.py が書き出した区ごとの GeoJSON。
 * 表示中の範囲に入った区の分だけを遅延読み込みし、地点の判定は
 * 読み込み済みの生データに対する内外判定で行う（描画状態に依存しない）。
 */
'use strict';

const LAYERS = ['youto', 'kodo', 'bouka'];
const LAYER_LABEL = { youto: '用途地域', kodo: '高度地区', bouka: '防火・準防火地域' };
const MIN_DATA_ZOOM = 12;
const GSI = 'https://cyberjapandata.gsi.go.jp/xyz';
const GSI_ATTR =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>';
const DATA_ATTR = '東京都都市整備局「都市計画決定情報GISデータ」を加工';

const BASEMAPS = {
  pale:  { url: `${GSI}/pale/{z}/{x}/{y}.png`, max: 18 },
  std:   { url: `${GSI}/std/{z}/{x}/{y}.png`, max: 18 },
  photo: { url: `${GSI}/seamlessphoto/{z}/{x}/{y}.jpg`, max: 18 },
};

/* 読み込んだ生データ。store[layer][wardCode] = [feature, ...] */
const store = { youto: {}, kodo: {}, bouka: {} };
const loading = {};           /* 進行中の fetch を区ごとに保持 */
/* 「選んで探す」用の住所ツリー。addrStore[wardCode] = {町丁目: [[番, lon, lat], ...]} */
const addrStore = {};
const addrLoading = {};
let wardsMeta = {};           /* wards.json の wards */
let tokyoGis = null;          /* wards.json の tokyo（東京都の全都域サービス） */
let codeTable = {};           /* codes.json */
let wardShapes = [];          /* {code, name, feature, bbox} */
let activeLayer = 'youto';
let marker = null;

const $ = (sel) => document.querySelector(sel);

/* ======================================================================
 * 幾何：点の内外判定
 * ==================================================================== */
function ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/* 外環に入っていて、どの内環（穴）にも入っていなければ内側 */
function polygonContains(rings, x, y) {
  if (!ringContains(rings[0], x, y)) return false;
  for (let i = 1; i < rings.length; i++) {
    if (ringContains(rings[i], x, y)) return false;
  }
  return true;
}

function geometryContains(geom, x, y) {
  if (!geom) return false;
  if (geom.type === 'Polygon') return polygonContains(geom.coordinates, x, y);
  if (geom.type === 'MultiPolygon') {
    return geom.coordinates.some((rings) => polygonContains(rings, x, y));
  }
  return false;
}

function bboxOf(geom) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const scan = (rings) => {
    for (const ring of rings) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  };
  if (geom.type === 'Polygon') scan(geom.coordinates);
  else if (geom.type === 'MultiPolygon') geom.coordinates.forEach(scan);
  return [minX, minY, maxX, maxY];
}

/* ----------------------------------------------------------------------
 * 測地系
 *
 * 東京都の「都市計画情報等インターネット提供サービス」は、URLの mpx/mpy を
 * 日本測地系として解釈する（gprj の値を変えても変わらない）。世界測地系のまま
 * 渡すと約460m北西にずれるので、リンクを作る前に変換する。
 * -------------------------------------------------------------------- */
function tokyoToWgs84(lat, lon) {
  return [
    lat - 0.00010695 * lat + 0.000017464 * lon + 0.0046017,
    lon - 0.000046038 * lat - 0.000083043 * lon + 0.01004,
  ];
}

/* 上の式を数値的に反転する（補正量がほぼ一定なので数回で収束する） */
function wgs84ToTokyo(lat, lon) {
  let tLat = lat;
  let tLon = lon;
  for (let i = 0; i < 3; i++) {
    const [wLat, wLon] = tokyoToWgs84(tLat, tLon);
    tLat += lat - wLat;
    tLon += lon - wLon;
  }
  return [tLat, tLon];
}

const bboxHas = (b, x, y) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
const bboxOverlaps = (a, b) =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/* ======================================================================
 * データ読み込み
 * ==================================================================== */
async function loadJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} が読み込めません (${res.status})`);
  return res.json();
}

function ensureWard(code) {
  if (loading[code]) return loading[code];
  if (store.youto[code]) return Promise.resolve();
  loading[code] = Promise.all(
    LAYERS.map((layer) =>
      loadJSON(`data/${layer}/${code}.json`).then((fc) => {
        store[layer][code] = fc.features.map((f) => ({
          properties: f.properties,
          geometry: f.geometry,
          bbox: bboxOf(f.geometry),
        }));
      })
    )
  ).then(() => {
    refreshSources();
  });
  return loading[code];
}

/* 住所ツリーは「選んで探す」で区を選んだ時だけ要る。地図のパンで巻き込み
 * 読み込みされないよう、ensureWard とは別立てにしている。 */
function ensureAddress(code) {
  if (addrLoading[code]) return addrLoading[code];
  if (addrStore[code]) return Promise.resolve();
  addrLoading[code] = loadJSON(`data/juusho/${code}.json`).then((tree) => {
    addrStore[code] = tree;
  });
  return addrLoading[code];
}

/* 表示範囲に重なる区を読み込む */
function wardsInView(map) {
  const b = map.getBounds();
  const view = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  return wardShapes.filter((w) => bboxOverlaps(w.bbox, view)).map((w) => w.code);
}

function refreshSources() {
  for (const layer of LAYERS) {
    const features = [];
    for (const code of Object.keys(store[layer])) {
      for (const f of store[layer][code]) {
        features.push({ type: 'Feature', properties: f.properties, geometry: f.geometry });
      }
    }
    const src = map.getSource(layer);
    if (src) src.setData({ type: 'FeatureCollection', features });
  }
}

/* ======================================================================
 * 地図
 * ==================================================================== */
const map = new maplibregl.Map({
  container: 'map',
  center: [139.7038, 35.6939],
  zoom: 13,
  minZoom: 9,
  maxZoom: 18,
  hash: true,
  attributionControl: false,
  style: {
    version: 8,
    sources: {
      base: {
        type: 'raster',
        tiles: [BASEMAPS.pale.url],
        tileSize: 256,
        maxzoom: BASEMAPS.pale.max,
        attribution: `${GSI_ATTR}｜${DATA_ATTR}`,
      },
    },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
  },
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
map.addControl(
  new maplibregl.GeolocateControl({ trackUserLocation: false, showAccuracyCircle: true }),
  'top-right'
);

function colorExpression(layer) {
  const key = { youto: 'y', kodo: 'k', bouka: 'f' }[layer];
  const expr = ['match', ['get', key]];
  for (const [code, def] of Object.entries(codeTable[layer])) {
    expr.push(Number(code), def.color);
  }
  expr.push('#cccccc');
  return expr;
}

function addDataLayers() {
  for (const layer of LAYERS) {
    map.addSource(layer, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
      id: `${layer}-fill`,
      type: 'fill',
      source: layer,
      paint: {
        'fill-color': colorExpression(layer),
        /* 非表示のレイヤーも不透明度0で残す（切り替えを軽くするため） */
        'fill-opacity': layer === activeLayer ? 0.55 : 0,
      },
    });
    map.addLayer({
      id: `${layer}-line`,
      type: 'line',
      source: layer,
      paint: {
        'line-color': 'rgba(40,45,55,.55)',
        'line-width': 0.7,
        'line-opacity': layer === activeLayer ? 1 : 0,
      },
    });
  }

  map.addSource('wards', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: wardShapes.map((w) => w.feature) },
  });
  map.addLayer({
    id: 'wards-line',
    type: 'line',
    source: 'wards',
    paint: { 'line-color': '#3a4250', 'line-width': 1.4, 'line-opacity': 0.75 },
  });
}

function setActiveLayer(layer) {
  activeLayer = layer;
  for (const l of LAYERS) {
    const on = l === layer;
    map.setPaintProperty(`${l}-fill`, 'fill-opacity', on ? 0.55 : 0);
    map.setPaintProperty(`${l}-line`, 'line-opacity', on ? 1 : 0);
  }
  document.querySelectorAll('.tab').forEach((b) => {
    b.classList.toggle('is-on', b.dataset.layer === layer);
  });
  renderLegend();
}

function setBasemap(kind) {
  const cfg = BASEMAPS[kind];
  map.getSource('base').setTiles([cfg.url]);
  document.querySelectorAll('.bm').forEach((b) => {
    b.classList.toggle('is-on', b.dataset.base === kind);
  });
}

/* ======================================================================
 * 表示
 * ==================================================================== */
function renderLegend() {
  const table = codeTable[activeLayer];
  $('#legend').innerHTML = Object.values(table)
    .map(
      (d) =>
        `<div class="legend-item"><span class="swatch" style="background:${d.color}"></span>${d.label}</div>`
    )
    .join('');
}

function findWard(lon, lat) {
  return wardShapes.find(
    (w) => bboxHas(w.bbox, lon, lat) && geometryContains(w.feature.geometry, lon, lat)
  );
}

function findFeature(layer, code, lon, lat) {
  const list = store[layer][code];
  if (!list) return null;
  for (const f of list) {
    if (bboxHas(f.bbox, lon, lat) && geometryContains(f.geometry, lon, lat)) return f;
  }
  return null;
}

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function cardYouto(p) {
  if (!p) return card('用途地域', '<span class="none">この地点には指定がありません</span>');
  const def = codeTable.youto[String(p.y)] || { label: '不明', color: '#ccc' };
  const rows = [
    ['建ぺい率', `${p.b}％`],
    ['容積率', `${p.v}％`],
  ];
  if (p.t) rows.push(['高さの最高限度', `${p.t}m`]);
  if (p.w) rows.push(['外壁の後退距離', `${p.w}m`]);
  if (p.m) rows.push(['敷地面積の最低限度', `${p.m}㎡`]);
  const extra = p.s
    ? '<p class="note">特例容積率適用地区です。容積率の移転により、指定容積率と異なる容積が認められる場合があります。</p>'
    : '';
  return card(
    '用途地域',
    `<span class="swatch" style="background:${def.color}"></span>${esc(def.label)}`,
    rows,
    extra
  );
}

function cardKodo(p) {
  if (!p) return card('高度地区', '<span class="none">この地点には指定がありません</span>');
  const def = codeTable.kodo[String(p.k)] || { label: '不明', color: '#ccc' };
  const rows = [];
  if (p.mx) rows.push(['最高限高度', `${p.mx}m`]);
  if (p.mn) rows.push(['最低限高度', `${p.mn}m`]);
  const shasen = codeTable.shasenKodo.includes(p.k)
    ? '<p class="note"><strong>斜線型の高度地区です（北側斜線制限あり）。</strong>北側に接道していない敷地では、容積率どおりの床を消化できないことがあります。</p>'
    : '';
  return card(
    '高度地区',
    `<span class="swatch" style="background:${def.color}"></span>${esc(def.label)}`,
    rows,
    shasen
  );
}

function cardBouka(p) {
  if (!p) return card('防火・準防火地域', '<span class="none">指定なし（法22条区域など）</span>');
  const def = codeTable.bouka[String(p.f)] || { label: '不明', color: '#ccc' };
  return card(
    '防火・準防火地域',
    `<span class="swatch" style="background:${def.color}"></span>${esc(def.label)}`
  );
}

function card(title, valueHtml, rows, extraHtml) {
  const dl = rows && rows.length
    ? `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`
    : '';
  return `<div class="card"><h3>${esc(title)}</h3><div class="val">${valueHtml}</div>${dl}${extraHtml || ''}</div>`;
}

function linkHtml(url, label, sub, cls) {
  return `<a class="gis-link${cls ? ' ' + cls : ''}" href="${esc(url)}" target="_blank" rel="noopener">` +
         `${esc(label)}<small>${esc(sub)}</small></a>`;
}

function gisLink(ward, lon, lat) {
  const meta = wardsMeta[ward.code];
  if (!meta) return '';
  const [tLat, tLon] = wgs84ToTokyo(lat, lon);
  const fill = (tpl) =>
    tpl
      .replace('{lon}', lon.toFixed(6))
      .replace('{lat}', lat.toFixed(6))
      .replace('{tlon}', tLon.toFixed(6))
      .replace('{tlat}', tLat.toFixed(6));

  if (meta.deep) {
    return linkHtml(fill(meta.gisUrl), `${ward.name}の公式GISでこの地点を開く`, meta.gisName);
  }
  /* 区のシステムが地点指定に対応していない区は、東京都の全都域サービスへ送る */
  return (
    linkHtml(fill(tokyoGis.url), '東京都の公式サービスでこの地点を開く', tokyoGis.name) +
    linkHtml(
      meta.gisUrl,
      `${ward.name}の公式サイトを開く`,
      `${meta.gisName}／地点の指定に対応していないため、開いた先で住所を入力してください`,
      'sub'
    )
  );
}

async function inspect(lon, lat, matchedTitle) {
  const ward = findWard(lon, lat);
  if (!ward) {
    $('#result').className = 'result empty';
    $('#result').textContent = 'この地点は東京23区の外です。';
    return;
  }

  if (marker) marker.remove();
  /* 既定オフセットは [0,-14] で、ピン先端が基準点の1px下に描かれる
   * （ズーム16.5なら約1.4mのズレになる）。-15 にすると先端が基準点に一致する。 */
  marker = new maplibregl.Marker({ color: '#1f6feb', offset: [0, -15], draggable: true })
    .setLngLat([lon, lat])
    .addTo(map);
  marker.on('dragend', () => {
    const p = marker.getLngLat();
    inspect(p.lng, p.lat);
  });

  $('#result').className = 'result';
  $('#result').innerHTML = `<p class="ward">${esc(ward.name)}</p><p class="coord">読み込み中…</p>`;

  await ensureWard(ward.code);

  const youto = findFeature('youto', ward.code, lon, lat);
  const kodo = findFeature('kodo', ward.code, lon, lat);
  const bouka = findFeature('bouka', ward.code, lon, lat);

  $('#result').innerHTML =
    `<p class="ward">${esc(ward.name)}</p>` +
    (matchedTitle ? `<p class="matched">検索一致：${esc(matchedTitle)}</p>` : '') +
    `<p class="coord">緯度 ${lat.toFixed(6)}／経度 ${lon.toFixed(6)}</p>` +
    `<p class="tip">ピンはドラッグで動かせます。動かした地点で引き直します。</p>` +
    cardYouto(youto && youto.properties) +
    cardKodo(kodo && kodo.properties) +
    cardBouka(bouka && bouka.properties) +
    gisLink(ward, lon, lat);

  document.getElementById('app').classList.remove('panel-collapsed');
  $('#resultBlock').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ======================================================================
 * 選んで探す（区 → 町名・丁目 → 番・番地）
 * ==================================================================== */
const CHOME_PLACEHOLDER = '町名・丁目を選択…';
const BAN_PLACEHOLDER = '番・番地を選択…';

/* 住居表示を実施している地区は「○番○号」、未実施（地番）は「○番地」。
 * ビルド側が未実施の要素にだけ4つ目の印を付けているので、それで出し分ける。 */
function banLabel(entry) {
  return entry[3] ? `${entry[0]}番地` : `${entry[0]}番`;
}

/* items は [value, label] の配列。先頭に未選択のプレースホルダを置く。
 * 中身が空なら、その段自体を隠す（前段を選ぶまで現れない）。 */
function fillSelect(sel, items, placeholder) {
  sel.innerHTML = '';
  const head = document.createElement('option');
  head.value = '';
  head.textContent = placeholder;
  sel.appendChild(head);
  for (const [value, label] of items) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    sel.appendChild(opt);
  }
  const step = sel.closest('.step');
  if (step) step.hidden = items.length === 0;
}

function resetSelect(sel, placeholder) {
  fillSelect(sel, [], placeholder);
}

async function onWardPicked(code) {
  resetSelect($('#chomeSel'), CHOME_PLACEHOLDER);
  resetSelect($('#banSel'), BAN_PLACEHOLDER);
  const w = wardShapes.find((x) => x.code === code);
  if (!w) return;
  map.fitBounds([[w.bbox[0], w.bbox[1]], [w.bbox[2], w.bbox[3]]],
                { padding: 30, duration: 900 });
  await ensureAddress(code);
  const names = Object.keys(addrStore[code] || {});
  fillSelect($('#chomeSel'), names.map((n) => [n, n]), CHOME_PLACEHOLDER);
}

/* 町名・丁目の段階では地点を確定しない。1つの丁目の中でも用途地域は変わるので、
 * 代表点の値を出すと「町全体がこの用途」と誤解される。ズームだけに留める。 */
function onChomePicked(code, chome) {
  resetSelect($('#banSel'), BAN_PLACEHOLDER);
  const blocks = (addrStore[code] || {})[chome];
  if (!blocks || !blocks.length) return;
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [, lon, lat] of blocks) {
    if (lon < w) w = lon;
    if (lon > e) e = lon;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  map.fitBounds([[w, s], [e, n]], { padding: 60, maxZoom: 17, duration: 900 });
  fillSelect($('#banSel'), blocks.map((b) => [b[0], banLabel(b)]), BAN_PLACEHOLDER);
}

function onBanPicked(code, chome, ban) {
  const blocks = (addrStore[code] || {})[chome] || [];
  const hit = blocks.find((b) => b[0] === ban);
  if (!hit) return;
  const [, lon, lat] = hit;
  const wardName = (wardShapes.find((x) => x.code === code) || {}).name || '';
  map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 16.5), duration: 900 });
  inspect(lon, lat, `${wardName}${chome}${banLabel(hit)}`);
}

/* ======================================================================
 * 住所検索（国土地理院ジオコーダ）
 * ==================================================================== */
async function search(query) {
  const msg = $('#searchMsg');
  msg.hidden = true;
  if (!query.trim()) return;
  try {
    const url =
      'https://msearch.gsi.go.jp/address-search/AddressSearch?q=' + encodeURIComponent(query.trim());
    const list = await loadJSON(url);
    if (!list.length) {
      msg.textContent = '住所が見つかりませんでした。表記を変えてお試しください。';
      msg.hidden = false;
      return;
    }
    const [lon, lat] = list[0].geometry.coordinates;
    if (!findWard(lon, lat)) {
      msg.textContent = 'この住所は東京23区の外のようです。';
      msg.hidden = false;
      return;
    }
    /* ジオコーダが返すのは住所の代表点。どこまで一致したか（号まで／番止まり）で
     * 実際の地点との差が変わるため、一致した住所そのものを結果に出す。 */
    const matched = list[0].properties && list[0].properties.title;
    map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 16.5), duration: 900 });
    inspect(lon, lat, matched);
  } catch (e) {
    msg.textContent = '住所検索に失敗しました（' + e.message + '）。地図を直接クリックしてください。';
    msg.hidden = false;
  }
}

/* ======================================================================
 * 音声入力（Web Speech API）
 * ==================================================================== */
const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;

function initVoiceSearch() {
  if (!SpeechRecognitionAPI) return; // 非対応ブラウザはボタンを出さない
  const micBtn = $('#micBtn');
  micBtn.hidden = false;

  micBtn.addEventListener('click', () => {
    if (recognizer) {
      recognizer.stop(); // 聞き取り中に再タップ→キャンセル
      return;
    }
    startListening(micBtn);
  });
}

function startListening(micBtn) {
  const msg = $('#searchMsg');
  msg.hidden = true;

  recognizer = new SpeechRecognitionAPI();
  recognizer.lang = 'ja-JP';
  recognizer.interimResults = false;
  recognizer.maxAlternatives = 1;

  micBtn.classList.add('is-listening');

  recognizer.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    $('#q').value = transcript;
    search(transcript);
  };
  recognizer.onerror = (e) => {
    const messages = {
      'not-allowed': 'マイクの利用が許可されていません。',
      'no-speech': '音声を認識できませんでした。もう一度お試しください。',
    };
    msg.textContent = messages[e.error] || '音声入力に失敗しました。';
    msg.hidden = false;
  };
  recognizer.onend = () => {
    micBtn.classList.remove('is-listening');
    recognizer = null;
  };

  recognizer.start();
}

/* ======================================================================
 * 起動
 * ==================================================================== */
async function loadBaseData() {
  const [meta, codes, wards, boundary] = await Promise.all([
    loadJSON('data/meta.json'),
    loadJSON('data/codes.json'),
    loadJSON('data/wards.json'),
    loadJSON('data/wards_boundary.json'),
  ]);
  codeTable = codes;
  wardsMeta = wards.wards;
  tokyoGis = wards.tokyo;

  wardShapes = boundary.features
    .map((f) => ({
      code: f.properties.code,
      name: f.properties.name,
      feature: f,
      bbox: bboxOf(f.geometry),
    }))
    .sort((a, b) => a.code.localeCompare(b.code));

  const kijunbi = meta.sources && meta.sources.youto && meta.sources.youto.kijunbi;
  $('#kijunbi').textContent = kijunbi
    ? `都市計画決定 ${kijunbi} 現在のデータ`
    : 'データ基準日：不明';
  $('#sourceLine').innerHTML =
    '出典：<a href="https://catalog.data.metro.tokyo.lg.jp/dataset/t000008d0000000028" target="_blank" rel="noopener">東京都都市整備局「都市計画決定情報GISデータ」</a>（CC BY 4.0）を加工して作成';
  if (meta.checkedAt) {
    $('#updatedLine').textContent =
      `最終更新確認：${meta.checkedAt.slice(0, 10)}` +
      (meta.builtAt ? `／データ取り込み：${meta.builtAt.slice(0, 10)}` : '');
  }

  const juusho = meta.sources && meta.sources.juusho;
  if (juusho) {
    $('#juushoLine').textContent =
      `住所の選択：街区レベル位置参照情報（国土交通省）${juusho.kijunbi || ''}を加工して作成`;
  }

  fillSelect($('#wardSel'), wardShapes.map((w) => [w.code, w.name]), '区を選択…');
  renderLegend();
}

function syncViewport() {
  const z = map.getZoom();
  const hint = $('#zoomHint');
  if (z < MIN_DATA_ZOOM) {
    hint.hidden = false;
    return;
  }
  hint.hidden = true;
  wardsInView(map).forEach(ensureWard);
}

/* ---- 起動 ----
 * 地図の描画完了を待たずにデータを読み込む。地図が使えない環境でも
 * 住所検索と地点情報が動くようにするため。
 */
const dataReady = loadBaseData().catch((e) => {
  $('#result').className = 'result';
  $('#result').innerHTML = `<p class="note">データの読み込みに失敗しました：${esc(e.message)}</p>`;
  throw e;
});
const mapReady = new Promise((resolve) => map.once('load', resolve));

Promise.all([dataReady, mapReady]).then(() => {
  addDataLayers();
  setActiveLayer(activeLayer);
  syncViewport();
});

/* ---- イベント ---- */
map.on('moveend', syncViewport);
map.on('click', (e) => inspect(e.lngLat.lng, e.lngLat.lat));
map.once('load', () => {
  map.getCanvas().style.cursor = 'crosshair';
});

document.getElementById('layerTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (btn) setActiveLayer(btn.dataset.layer);
});
document.getElementById('basemaps').addEventListener('click', (e) => {
  const btn = e.target.closest('.bm');
  if (btn) setBasemap(btn.dataset.base);
});
document.getElementById('searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  search($('#q').value);
});
document.getElementById('wardSel').addEventListener('change', (e) => {
  onWardPicked(e.target.value);
});
document.getElementById('chomeSel').addEventListener('change', (e) => {
  onChomePicked($('#wardSel').value, e.target.value);
});
document.getElementById('banSel').addEventListener('change', (e) => {
  onBanPicked($('#wardSel').value, $('#chomeSel').value, e.target.value);
});
document.getElementById('panelToggle').addEventListener('click', () => {
  document.getElementById('app').classList.toggle('panel-collapsed');
});
initVoiceSearch();
