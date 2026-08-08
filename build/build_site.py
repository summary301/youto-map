# -*- coding: utf-8 -*-
"""東京都オープンデータの都市計画GISデータを取り込み、サイト用の GeoJSON を書き出す。

  python build/build_site.py            … 更新があった時だけ再構築
  python build/build_site.py --force    … 更新の有無に関わらず再構築

更新判定は配布ZIPの Last-Modified ヘッダで行う（元データの更新頻度は公称1年ごと
なので、週次で回してもほとんどの週は「変更なし」で即終了する）。

出典:
  東京都都市整備局「都市計画決定情報GISデータ」（CC BY 4.0）
  国土交通省 国土数値情報「行政区域データ」（区界の判定用）
"""
from __future__ import annotations

import argparse
import io
import json
import re
import shutil
import sys
import time
import urllib.request
import zipfile
from datetime import datetime, timezone, timedelta
from pathlib import Path

import shapefile  # pyshp
from pyproj import Transformer
from shapely.geometry import shape as shapely_shape
from shapely.ops import transform as shapely_transform
from shapely.strtree import STRtree

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SITE = ROOT / "site"
DATA = SITE / "data"
CACHE = ROOT / ".cache"

sys.path.insert(0, str(HERE))
import codes as CODES          # noqa: E402
import wards as WARDS          # noqa: E402

JST = timezone(timedelta(hours=9))
UA = "youto-map-builder/1.0 (+https://github.com/)"

# 東京都都市整備局の配布ZIP
TOKYO_BASE = "https://www.opendata.metro.tokyo.lg.jp/toshiseibi/"
LAYERS = {
    "youto": {"zip": "gis01_youtochiiki.zip", "label": "用途地域"},
    "kodo":  {"zip": "gis02_koudochiku.zip",  "label": "高度地区"},
    "bouka": {"zip": "gis03_bouka.zip",       "label": "防火・準防火地域"},
}

# 区界（国土数値情報 行政区域データ）
N03_URL = "https://nlftp.mlit.go.jp/ksj/gml/data/N03/N03-2025/N03-20250101_13_GML.zip"

# 東京都の平面直角座標系第9系（JGD2011）→ WGS84
TO_WGS84 = Transformer.from_crs("EPSG:6677", "EPSG:4326", always_xy=True)

SIMPLIFY_M = 1.0        # 用途地域等の簡略化許容誤差（メートル）
SIMPLIFY_WARD_M = 8.0   # 区界の簡略化許容誤差（メートル）
WARD_PAD_DEG = 0.0003   # 区界クリップ時の余裕（度・約30m）
COORD_DIGITS = 6        # 小数6桁 ≒ 0.11m


def log(msg):
    print(f"[{datetime.now(JST):%H:%M:%S}] {msg}", flush=True)


# --------------------------------------------------------------------------
# ダウンロード
# --------------------------------------------------------------------------
def head(url):
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return {
            "last_modified": r.headers.get("Last-Modified"),
            "length": int(r.headers.get("Content-Length") or 0),
        }


def download(url, dest: Path):
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=300) as r, open(dest, "wb") as f:
                shutil.copyfileobj(r, f)
            return dest
        except Exception as e:                       # noqa: BLE001
            if attempt == 2:
                raise
            log(f"  ダウンロード失敗（{e}）… {5 * (attempt + 1)}秒後に再試行")
            time.sleep(5 * (attempt + 1))
    return dest


def unzip_find_shp(zip_path: Path, out_dir: Path) -> Path:
    """ZIPを展開して .shp のパスを返す。"""
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    with zipfile.ZipFile(zip_path) as z:
        # ZIP内のファイル名がCP932の場合があるため、無害な名前に付け替えて展開する
        for info in z.infolist():
            if info.is_dir():
                continue
            raw = info.filename.encode("cp437", "ignore") if not info.flag_bits & 0x800 \
                else info.filename.encode("utf-8")
            try:
                name = raw.decode("cp932")
            except UnicodeDecodeError:
                name = info.filename
            target = out_dir / Path(name.replace("\\", "/")).name
            with z.open(info) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
    shps = sorted(out_dir.glob("*.shp"))
    if not shps:
        raise RuntimeError(f"{zip_path.name} に .shp が見つかりません")
    return shps[0]


# --------------------------------------------------------------------------
# ジオメトリ
# --------------------------------------------------------------------------
def to_wgs84(geom):
    return shapely_transform(lambda x, y, z=None: TO_WGS84.transform(x, y), geom)


def round_coords(obj, digits=COORD_DIGITS):
    """GeoJSONの座標配列を再帰的に丸める。"""
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], (int, float)):
            return [round(float(v), digits) for v in obj]
        return [round_coords(v, digits) for v in obj]
    return obj


def dbf_encoding(shp_path: Path) -> str:
    """.cpg があればそれに従い、無ければ CP932 とみなす。

    東京都の都市計画GISデータは .cpg 無し（CP932）、国土数値情報の行政区域は
    .cpg ありで UTF-8。取り違えると日本語フィールドの復号に失敗する。
    """
    cpg = shp_path.with_suffix(".cpg")
    if cpg.exists():
        name = cpg.read_text(encoding="ascii", errors="ignore").strip().lower()
        if name:
            return {"utf_8": "utf-8", "utf8": "utf-8"}.get(name, name)
    return "cp932"


def read_polygons(shp_path: Path):
    """(属性dict, ファイル座標系のshapelyジオメトリ) を順に返す。"""
    reader = shapefile.Reader(str(shp_path), encoding=dbf_encoding(shp_path))
    fields = [f[0] for f in reader.fields[1:]]
    for sr in reader.iterShapeRecords():
        if not sr.shape.points:
            continue
        try:
            geom = shapely_shape(sr.shape.__geo_interface__)
        except Exception:                            # noqa: BLE001
            continue
        if geom.is_empty:
            continue
        if not geom.is_valid:
            geom = geom.buffer(0)
            if geom.is_empty:
                continue
        yield dict(zip(fields, list(sr.record))), geom
    reader.close()


def num(v, default=0):
    try:
        if v in (None, ""):
            return default
        return int(round(float(v)))
    except (TypeError, ValueError):
        return default


# --------------------------------------------------------------------------
# 区界
# --------------------------------------------------------------------------
def build_ward_index():
    """23区の境界を読み、(コード順リスト, STRtree, 対応表) を返す。"""
    zip_path = CACHE / "n03.zip"
    if not zip_path.exists():
        log("区界データ（国土数値情報 行政区域）をダウンロード中…")
        download(N03_URL, zip_path)
    shp = unzip_find_shp(zip_path, CACHE / "n03")

    parts: dict[str, list] = {}
    for rec, geom in read_polygons(shp):
        code = str(rec.get("N03_007") or "").strip()
        if code in WARDS.WARDS:
            parts.setdefault(code, []).append(geom)

    missing = set(WARDS.WARDS) - set(parts)
    if missing:
        raise RuntimeError(f"区界が取得できない区があります: {sorted(missing)}")

    from shapely.ops import unary_union
    ward_codes, ward_geoms = [], []
    for code in WARDS.WARD_CODES:
        merged = unary_union(parts[code])
        ward_codes.append(code)
        ward_geoms.append(merged)          # N03は既に緯度経度（WGS84）
    log(f"区界を読み込みました（{len(ward_codes)}区）")
    return ward_codes, ward_geoms, STRtree(ward_geoms)


def write_ward_boundary(ward_codes, ward_geoms):
    """区の選択・区名判定に使う軽量な境界GeoJSON。"""
    # 簡略化はメートル基準で行いたいので、いったん平面直角座標へ戻す
    to_plane = Transformer.from_crs("EPSG:4326", "EPSG:6677", always_xy=True)
    feats = []
    for code, geom in zip(ward_codes, ward_geoms):
        plane = shapely_transform(lambda x, y, z=None: to_plane.transform(x, y), geom)
        simple = to_wgs84(plane.simplify(SIMPLIFY_WARD_M, preserve_topology=True))
        gj = simple.__geo_interface__
        feats.append({
            "type": "Feature",
            "properties": {"code": code, "name": WARDS.WARD_NAME_BY_CODE[code]},
            "geometry": {"type": gj["type"],
                         "coordinates": round_coords(gj["coordinates"])},
        })
    path = DATA / "wards_boundary.json"
    path.write_text(json.dumps({"type": "FeatureCollection", "features": feats},
                               ensure_ascii=False, separators=(",", ":")),
                    encoding="utf-8")
    return path


# --------------------------------------------------------------------------
# 属性の取り出し
# --------------------------------------------------------------------------
def props_youto(rec):
    p = {"y": num(rec.get("TUP3F1")),
         "v": num(rec.get("TUP3F3")),
         "b": num(rec.get("TUP3F4"))}
    if num(rec.get("TAKASA")):
        p["t"] = num(rec["TAKASA"])                     # 高さの最高限度(m)
    if float(rec.get("TUP3F5") or 0):
        p["w"] = round(float(rec["TUP3F5"]), 1)         # 外壁後退距離(m)
    if num(rec.get("TUP3F6")):
        p["m"] = num(rec["TUP3F6"])                     # 敷地面積の最低限度(m2)
    if num(rec.get("TUP3F7")):
        p["s"] = 1                                      # 特例容積率適用地区
    return p


def props_kodo(rec):
    p = {"k": num(rec.get("TUP5F1"))}
    if num(rec.get("TUP5F4")):
        p["mx"] = num(rec["TUP5F4"])                    # 最高限高度(m)
    if num(rec.get("TUP5F3")):
        p["mn"] = num(rec["TUP5F3"])                    # 最低限高度(m)
    return p


def props_bouka(rec):
    return {"f": num(rec.get("TUP6F1"))}


EXTRACT = {"youto": props_youto, "kodo": props_kodo, "bouka": props_bouka}


# --------------------------------------------------------------------------
# メイン
# --------------------------------------------------------------------------
def kijunbi_from_filename(name: str) -> str | None:
    """用途地域_R070331.shp → 令和7年3月31日"""
    m = re.search(r"_([RH])(\d{2})(\d{2})(\d{2})\.", name)
    if not m:
        return None
    era = {"R": "令和", "H": "平成"}[m.group(1)]
    return f"{era}{int(m.group(2))}年{int(m.group(3))}月{int(m.group(4))}日"


def polygon_parts(geom):
    """intersection の結果から面だけを取り出す（線・点は捨てる）。"""
    if geom.is_empty:
        return None
    if geom.geom_type in ("Polygon", "MultiPolygon"):
        return geom
    if geom.geom_type == "GeometryCollection":
        polys = [g for g in geom.geoms if g.geom_type in ("Polygon", "MultiPolygon")]
        if not polys:
            return None
        from shapely.ops import unary_union
        return unary_union(polys)
    return None


def build_layer(key, shp_path, ward_codes, ward_geoms, ward_pad, tree):
    label = LAYERS[key]["label"]
    extract = EXTRACT[key]
    buckets: dict[str, list] = {c: [] for c in ward_codes}
    total = kept = 0

    for rec, plane_geom in read_polygons(shp_path):
        total += 1
        simple = plane_geom.simplify(SIMPLIFY_M, preserve_topology=True)
        if simple.is_empty:
            continue
        geom = to_wgs84(simple)
        props = extract(rec)

        hit = False
        for idx in tree.query(geom):
            ward = ward_geoms[idx]
            if not geom.intersects(ward):
                continue
            hit = True
            # 防火地域のように区をまたぐ巨大ポリゴンは、そのまま各区へ複製すると
            # 出力が肥大する。区界でクリップし、境界に隙間が出ないよう少しだけ
            # 外側に広げた区界を使う（隣接区とわずかに重なる）。
            if ward.contains(geom):
                piece = geom
            else:
                piece = polygon_parts(geom.intersection(ward_pad[idx]))
                if piece is None:
                    continue
            gj = piece.__geo_interface__
            buckets[ward_codes[idx]].append({
                "type": "Feature",
                "properties": props,
                "geometry": {"type": gj["type"],
                             "coordinates": round_coords(gj["coordinates"])},
            })
        if hit:
            kept += 1

    out_dir = DATA / key
    out_dir.mkdir(parents=True, exist_ok=True)
    sizes = {}
    for code, feats in buckets.items():
        path = out_dir / f"{code}.json"
        path.write_text(json.dumps({"type": "FeatureCollection", "features": feats},
                                   ensure_ascii=False, separators=(",", ":")),
                        encoding="utf-8")
        sizes[code] = path.stat().st_size
    log(f"  {label}: 全{total}件 → 23区内{kept}件 / "
        f"出力{sum(sizes.values()) / 1024 / 1024:.1f}MB")
    return sizes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="更新が無くても再構築する")
    args = ap.parse_args()

    DATA.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)
    meta_path = DATA / "meta.json"
    old_meta = {}
    if meta_path.exists():
        old_meta = json.loads(meta_path.read_text(encoding="utf-8"))

    # コード表と区のリンクはコード側で決まるので、配布元の更新とは無関係に毎回書き出す
    (DATA / "codes.json").write_text(
        json.dumps(CODES.as_json(), ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")
    (DATA / "wards.json").write_text(
        json.dumps(WARDS.as_json(), ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")

    # ---- 更新判定 -------------------------------------------------------
    log("配布元の更新を確認中…")
    remote = {}
    for key, cfg in LAYERS.items():
        remote[key] = head(TOKYO_BASE + cfg["zip"])
        log(f"  {cfg['label']}: Last-Modified={remote[key]['last_modified']}")

    old_sources = old_meta.get("sources", {})
    changed = args.force or any(
        old_sources.get(k, {}).get("lastModified") != remote[k]["last_modified"]
        for k in LAYERS
    )
    if not changed:
        log("変更はありません。再構築せずに終了します。")
        meta = dict(old_meta)
        meta["checkedAt"] = datetime.now(JST).isoformat(timespec="seconds")
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=1),
                             encoding="utf-8")
        print("::CHANGED=0::")
        return 0

    log("更新を検出しました。再構築します。")

    ward_codes, ward_geoms, tree = build_ward_index()
    write_ward_boundary(ward_codes, ward_geoms)
    # クリップ時に境界へ隙間ができないよう約30m外側に広げた区界
    ward_pad = [g.buffer(WARD_PAD_DEG) for g in ward_geoms]

    sources, kijunbi = {}, {}
    for key, cfg in LAYERS.items():
        log(f"{cfg['label']} を取得中…")
        zip_path = CACHE / cfg["zip"]
        download(TOKYO_BASE + cfg["zip"], zip_path)
        shp = unzip_find_shp(zip_path, CACHE / key)
        kijunbi[key] = kijunbi_from_filename(shp.name)
        build_layer(key, shp, ward_codes, ward_geoms, ward_pad, tree)
        sources[key] = {
            "label": cfg["label"],
            "url": TOKYO_BASE + cfg["zip"],
            "lastModified": remote[key]["last_modified"],
            "kijunbi": kijunbi[key],
        }

    meta = {
        "builtAt": datetime.now(JST).isoformat(timespec="seconds"),
        "checkedAt": datetime.now(JST).isoformat(timespec="seconds"),
        "sources": sources,
        "attribution": [
            "東京都都市整備局「都市計画決定情報GISデータ」（CC BY 4.0）を加工して作成",
            "国土交通省 国土数値情報「行政区域データ」を加工して作成（区界）",
            "地理院タイル（国土地理院）",
        ],
    }
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    log("完了しました。")
    print("::CHANGED=1::")
    return 0


if __name__ == "__main__":
    sys.exit(main())
