# -*- coding: utf-8 -*-
"""
Gợi ý kênh YouTube THẬT bằng yt-dlp: tìm video theo từ khóa -> gom theo kênh ->
lấy số đăng ký (subscriber) + avatar + mô tả, xếp theo subscriber giảm dần.

Dùng:  python yt_goi_y.py "<từ khóa>"
Env:   GOI_Y_OUT (json ra), GOI_Y_LIMIT (số kênh, mặc định 12),
       GOI_Y_MIN_VIDEO (ngưỡng "≥N video" — dò đúng N mục để ĐẾM, xem _MIN_DO/_MAX_DO)
"""
import os
import sys
import json
from concurrent.futures import ThreadPoolExecutor

from yt_dlp import YoutubeDL

THU_MUC_GOC = os.path.dirname(os.path.abspath(__file__))
THU_MUC_CRAWLER = os.path.join(THU_MUC_GOC, "MediaCrawler")

# 🔴 ĐẾM VIDEO KÊNH — vì sao dò "1:N" chứ không quét hết (đo 24/08, kênh 4364 video):
#   items="1" 0,7s · "1:30" 0,6s · "1:100" 1,3s · "1:1000" 9,3s · QUÉT HẾT 40,3s.
#   20 kênh/từ khoá × 40,3s = 13 PHÚT chỉ để đếm ⇒ loại. Mà bộ lọc chỉ hỏi "có ≥N không",
#   nên dò ĐÚNG N mục là đủ: đủ N ⇒ "≥N"; thiếu N ⇒ hết kênh ⇒ đó là số THẬT.
_MIN_DO = 30        # 1 trang YouTube = 30 mục ⇒ dò 30 TỐN BẰNG dò 1. Lấy free, đừng bỏ.
_MAX_DO = 1000      # trần bảo vệ: trên mức này (9,3s/kênh) thì "≥1000" đã đủ để quyết.


def _ydl(extra):
    opts = {"quiet": True, "no_warnings": True, "skip_download": True,
            "ignoreerrors": True, "socket_timeout": 20}
    opts.update(extra)
    return YoutubeDL(opts)


def _avatar(thumbs):
    if not thumbs:
        return ""
    # Ưu tiên ảnh vuông (avatar) thay vì banner ngang
    vuong = [t for t in thumbs if t.get("width") and t.get("height")
             and abs(t["width"] - t["height"]) <= 4]
    chon = (vuong or thumbs)[-1]
    return chon.get("url", "")


def goi_y_youtube(keyword, so_video=0, limit=12, nguong=0):
    # 🔴 SỐ VIDEO TÌM MỚI LÀ TRẦN THẬT CHO SỐ KÊNH. Kênh lấy từ TÁC GIẢ của video tìm được,
    #    mà nhiều video trùng tác giả ⇒ 25 video chỉ ra ~18 kênh (đo 24/08). Để cố định 25 thì
    #    khách xin 100 kênh vẫn chỉ nhận ~18, không lời giải thích nào. Nhân 3 cho phần trùng.
    so_video = int(so_video or 0) or max(25, min(300, int(limit or 12) * 3))
    with _ydl({"extract_flat": True}) as ydl:
        res = ydl.extract_info(f"ytsearch{so_video}:{keyword}", download=False) or {}
    entries = res.get("entries") or []
    chans, order = {}, []
    for e in entries:
        if not e:
            continue
        cu = e.get("channel_url") or e.get("uploader_url")
        ten = e.get("channel") or e.get("uploader")
        if not cu or not ten:
            continue
        if cu not in chans:
            chans[cu] = {"ten": ten}
            order.append(cu)
    order = order[:limit]
    cap = max(_MIN_DO, min(_MAX_DO, int(nguong or 0)))

    def lay_1(cu):
        # videos_count = -1 nghĩa "CHƯA ĐO ĐƯỢC" (hỏng mạng/kênh riêng tư) — KHÔNG phải 0.
        # Rơi về 0 là bị bộ lọc ngưỡng quét sạch, khách tưởng từ khoá không có kênh nào.
        # videos_do=1  : bản script này đã đo thật (bên web_app dựa vào cờ này).
        # videos_it_nhat=1 : đủ `cap` mục ⇒ chỉ biết "≥cap", không phải số chính xác.
        out = {"nickname": chans[cu]["ten"], "link": cu, "avatar": "",
               "fans": 0, "videos_count": -1, "videos_do": 0, "videos_it_nhat": 0,
               "signature": ""}
        # 🔴 PHẢI dò "/videos", KHÔNG dò URL kênh trần. Đo 24/08: với nhiều kênh CHÍNH THỐNG
        #    URL trần trả về TAB/PLAYLIST (`_type="playlist"`) chứ không phải video —
        #    iQIYI ra 3 "mục" (3 tab) trong khi tab Videos có ≥400; Huace 2; Best Short 2.
        #    Đếm trên URL trần ⇒ kênh TO NHẤT bị ngưỡng loại sạch vì "3 video": sai ÂM THẦM,
        #    tệ hơn hẳn dấu "?" cũ. Bẫy ở chỗ kênh KHÁC thì URL trần LẠI ra video bình thường
        #    ⇒ thử một kênh là tưởng chạy đúng. "/videos" còn nhanh hơn (0,6s vs 1,5s) và
        #    giữ nguyên fans + mô tả + avatar (đã đối chiếu từng trường).
        _cu = cu.rstrip("/")
        for u, dem_duoc in ((_cu + "/videos", True), (_cu, False)):
            try:
                with _ydl({"extract_flat": True, "playlist_items": "1:%d" % cap}) as ydl:
                    ci = ydl.extract_info(u, download=False) or {}
            except Exception:
                continue
            # `ignoreerrors` nuốt lỗi thành None/{} -> đừng coi cái rỗng là "kênh 0 video".
            if not (ci.get("channel") or ci.get("uploader")
                    or ci.get("channel_follower_count")):
                continue
            out["nickname"] = ci.get("channel") or ci.get("uploader") or out["nickname"]
            out["fans"] = ci.get("channel_follower_count") or 0
            out["signature"] = (ci.get("description") or "").strip()[:140]
            out["avatar"] = _avatar(ci.get("thumbnails"))
            if dem_duoc:
                # lớp chắn 2: CHỈ đếm mục `_type="url"` = video thật. Tab/playlist lọt vào
                # thì cũng không bao giờ được tính, kể cả khi YouTube đổi cách trả.
                _es = [e for e in (ci.get("entries") or []) if e
                       and str(e.get("_type")) == "url"]
                out["videos_count"] = len(_es)
                out["videos_do"] = 1
                out["videos_it_nhat"] = 1 if len(_es) >= cap else 0
            break
        return out

    with ThreadPoolExecutor(max_workers=6) as ex:
        creators = list(ex.map(lay_1, order))
    creators.sort(key=lambda c: c.get("fans") or 0, reverse=True)
    return creators


def main():
    keyword = sys.argv[1] if len(sys.argv) > 1 else ""
    limit = int(os.environ.get("GOI_Y_LIMIT", "12"))
    try:
        nguong = int(os.environ.get("GOI_Y_MIN_VIDEO", "0") or 0)
    except ValueError:
        nguong = 0
    out_path = os.environ.get("GOI_Y_OUT") or os.path.join(
        THU_MUC_CRAWLER, "data", "youtube", "_goi_y_kenh.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    creators = []
    try:
        creators = goi_y_youtube(keyword, limit=limit, nguong=nguong)
    except Exception as e:
        print("YT_GOI_Y_ERR " + str(e))
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(creators, f, ensure_ascii=False)
    print("YT_GOI_Y_DONE " + str(len(creators)))


if __name__ == "__main__":
    main()
