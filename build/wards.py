# -*- coding: utf-8 -*-
"""東京23区の定義と、各区公式の都市計画GISへのリンク。

リンクのテンプレートは monitor/kodo_lookup.py の WARD_SYSTEMS（23区全数で
実地検証済み）と monitor/ward_gis_survey.md から移植したもの。
{lon} {lat} は表示側で実数に置換される（世界測地系・十進度）。

deep=True … クリック地点を地図中心に開けることを実地確認済みの区
deep=False… 区のシステム側に座標を渡す手段が無いことを確認した区。
            この2区（千代田・杉並）は東京都の全都域サービス TOKYO_GIS へ地点指定で送り、
            区の公式サイトは補助リンクとして併記する。
              - 千代田区: ArcGIS Experience Builder がURLパラメータ非対応。center を
                緯度経度でも平面直角座標(sr=2451)でも渡したが、identifyの座標・mapExtent
                が毎回同一で、地図は常に既定範囲を読む（2026-08-07 確認）
              - 杉並区: すぎナビ(Vue)のルーター定義が /mp/:mp と /mp/:mp/vlf/:vlf のみで、
                クエリパラメータを読む処理が存在しない（2026-08-07 app.js を確認）
"""

WAGMAP = ("https://www2.wagmap.jp/{site}/Map"
          "?mid={mid}&mpx={{lon}}&mpy={{lat}}&mps=2500&mtp=dm&gprj=3")
SONIC = ("https://www.sonicweb-asp.jp/{site}/map"
         "?theme={theme}&pos={{lon}},{{lat}}&scale=1000")
GEOCLOUD = ("https://{host}/webgis/"
            "?z=17&ll={{lat}},{{lon}}&t=dm&mp={mp}&op={op}&vlf={vlf}")


def _wagmap(site, mid):
    return WAGMAP.format(site=site, mid=mid)


def _sonic(site, theme):
    return SONIC.format(site=site, theme=theme)


def _geocloud(host, mp, op, vlf):
    return GEOCLOUD.format(host=host, mp=mp, op=op, vlf=vlf)


# 東京都都市整備局の全都域サービス。区のシステムが地点指定に対応していない区の受け皿。
# 【重要】このサービスの mpx/mpy は**日本測地系**として解釈される（gprj の値を変えても
# 変わらない）。世界測地系のまま渡すと約460m北西へずれる。表示側で日本測地系へ変換して
# から {tlon}/{tlat} に入れること。
# 検証: 中野区沼袋1-32-1 で変換後の座標を渡し、現在地表示「中野区沼袋１丁目」・
#       誤差0.9m を確認（2026-08-07）。
TOKYO_GIS = {
    "name": "東京都 都市計画情報等インターネット提供サービス",
    "url": ("https://www2.wagmap.jp/tokyo_tokeizu/Map"
            "?mid=1&mpx={tlon}&mpy={tlat}&mps=2500&mtp=dm&gprj=3"),
}


# code: (区名, 公式GIS名, URLテンプレート, deep)
WARDS = {
    "13101": ("千代田区", "都市計画情報マップ",
              "https://tokei-gis2.chiyodatoshikei.jp/toshikei/apps/experiencebuilder"
              "/experience/?id=deb533331f84464098ff8a18fafd5e84", False),
    "13102": ("中央区", "中央区都市計画情報等閲覧システム",
              "https://chuo-map.jp/map.php?lat={lat}&lon={lon}&near=near", True),
    "13103": ("港区", "港区都市計画情報提供サービス",
              _sonic("minato", "th_4"), True),
    "13104": ("新宿区", "新宿区みんなのGIS",
              _sonic("shinjuku2", "toshikeikaku"), True),
    "13105": ("文京区", "文京区都市計画図検索システム",
              _sonic("bunkyo-youto", "th_4"), True),
    "13106": ("台東区", "たいとうマップ（都市計画マップ）",
              _wagmap("taito", 2), True),
    "13107": ("墨田区", "すみだまちづくりマップ",
              _sonic("sumida", "th_12"), True),
    "13108": ("江東区", "江東区地図情報サービス",
              _geocloud("koto.geocloud.jp", "4", "66", "00183c"), True),
    "13109": ("品川区", "しながわMAP（用途地域等指定図）",
              _wagmap("shinagawa", 88), True),
    "13110": ("目黒区", "めぐろ地図情報サービス",
              _sonic("meguro", "th_4"), True),
    "13111": ("大田区", "まちマップおおた",
              _wagmap("ota", 1000), True),
    "13112": ("世田谷区", "せたがやiMap",
              _sonic("setagaya", "toshikeikaku"), True),
    "13113": ("渋谷区", "渋谷区地図情報システム",
              _wagmap("shibuya", 1000), True),
    "13114": ("中野区", "なかのデータマップ（都市計画マップ）",
              _wagmap("nakanodatamap", 62), True),
    "13115": ("杉並区", "すぎナビ（都市計画情報）",
              "https://suginami.geocloud.jp/mp/300/vlf/1fffffffffdf", False),
    "13116": ("豊島区", "豊島区地図情報システム",
              _wagmap("toshima", 2), True),
    "13117": ("北区", "北区の地図（詳細版）",
              _wagmap("kitaku", 2), True),
    "13118": ("荒川区", "荒川区地図情報",
              _wagmap("arakawa", 3), True),
    "13119": ("板橋区", "板橋区都市計画情報マップ",
              _geocloud("itabashi.geocloud.jp", "1", "100", "-1"), True),
    "13120": ("練馬区", "地図情報ねりまっぷ",
              _sonic("nerimap", "th_236"), True),
    "13121": ("足立区", "あだち地図情報提供サービス",
              _sonic("adachi2", "th_7"), True),
    "13122": ("葛飾区", "かつしか電子まっぷ",
              _sonic("katsushika", "th_45"), True),
    "13123": ("江戸川区", "江戸川区都市計画・指定道路情報提供サービス",
              _wagmap("edogawa", 1), True),
}

WARD_CODES = sorted(WARDS)
WARD_NAME_BY_CODE = {c: v[0] for c, v in WARDS.items()}


def as_json():
    """表示側に渡す形へ。"""
    return {
        "wards": {
            code: {
                "name": name,
                "gisName": gis_name,
                "gisUrl": url,
                "deep": deep,
            }
            for code, (name, gis_name, url, deep) in WARDS.items()
        },
        "tokyo": TOKYO_GIS,
    }
