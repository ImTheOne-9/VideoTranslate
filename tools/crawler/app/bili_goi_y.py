# -*- coding: utf-8 -*-
"""
Gợi ý kênh Bilibili THẬT (không mô phỏng).
🔴 24/08 — ĐỔI TỪ `upuser` SANG `video`. `search.bilibili.com/upuser` tìm theo TÊN KÊNH,
nên với từ khoá CHỦ ĐỀ nó ra 0: đo thật với 修仙电影, chính Bilibili in ra tab “用户 0”
(YouTube/Douyin cùng từ khoá ra 18 và 25 kênh — hai nền đó tìm VIDEO rồi lấy TÁC GIẢ).
Nay làm giống: tìm VIDEO → gom UP chủ video → hỏi API lấy follow/số video/avatar.
Đo 24/08: trang video ra 40 UP trong 8,7s; 3 UP hỏi số liệu mất 1,0s.

Dùng:  python bili_goi_y.py "<từ khóa>"
Env:   GOI_Y_OUT (đường dẫn json ra), GOI_Y_LIMIT (số kênh, mặc định 20),
       GOI_Y_HEADLESS ("1" ẩn / "0" hiện, mặc định "1")
Kết quả: ghi JSON list các kênh ra GOI_Y_OUT (mặc định MediaCrawler/data/bili/_goi_y_kenh.json)
"""
import os
import sys
import json
import time

from playwright.sync_api import sync_playwright

# TU TRO Chromium ve runtime/ms-playwright khi app spawn THIEU env PLAYWRIGHT_BROWSERS_PATH.
# Da gap THAT tren may khach: cai ngoai o C / relaunch sau update truyen env toi thieu -> Playwright dung
# default %LOCALAPPDATA%/ms-playwright -> "Executable does not exist chrome.exe" -> moi tinh nang dung trinh
# duyet HONG AM THAM (dich Gemini web, kiem tra login, cua so Luot, cao XHS...). mo_dang_nhap.py da co doan
# nay tu lau, cac file con lai thi KHONG -> cua so dang nhap mo duoc ma dich/cao van hong.
# Suy tu sys.executable (.../runtime/venv/Scripts/python.exe) nen KHONG phu thuoc env truyen vao.
# Chi set khi env dang RONG va thu muc CO THAT -> khong dung may dev / cau hinh khac.
if not (os.environ.get("PLAYWRIGHT_BROWSERS_PATH") or "").strip():
    try:
        _venv_dir = os.path.dirname(os.path.dirname(os.path.abspath(sys.executable)))
        _bp = os.path.join(os.path.dirname(_venv_dir), "ms-playwright")
        if os.path.isdir(_bp):
            os.environ["PLAYWRIGHT_BROWSERS_PATH"] = _bp
    except Exception:
        pass


THU_MUC_GOC = os.path.dirname(os.path.abspath(__file__))
THU_MUC_CRAWLER = os.path.join(THU_MUC_GOC, "MediaCrawler")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

JS_TRICH = r"""
async (limit) => {
  // Gom UP chủ các video trong kết quả tìm. Chỉ nhận link /<mid> có SỐ, và bỏ mấy link
  // trong THANH ĐẦU TRANG (lịch sử/bộ sưu tập của chính khách) — chúng cũng trỏ
  // space.bilibili.com nhưng không phải kết quả tìm.
  const bo = document.querySelector(".bili-header") || document.querySelector("#biliMainHeader");
  const m = new Map();
  document.querySelectorAll('a[href*="space.bilibili.com"]').forEach(a => {
    if (bo && bo.contains(a)) return;
    const g = (a.getAttribute("href") || "").match(/space\.bilibili\.com\/(\d+)/);
    if (!g) return;
    // tên UP nằm ngay trong thẻ, nhưng hay dính đuôi "· 08-20" (ngày đăng) ⇒ cắt.
    let t = (a.innerText || "").split("\n")[0].split("·")[0].trim();
    if (!t || t.length > 40) return;
    if (!m.has(g[1])) m.set(g[1], t);
  });
  const ids = [...m.keys()].slice(0, Math.max(1, (limit || 20) * 2));
  const ra = [];
  // Hỏi số liệu theo LÔ NHỎ song song: 1 UP cần 2 lời gọi, làm tuần tự 60 UP là quá lâu.
  const lo = 6;
  for (let i = 0; i < ids.length; i += lo) {
    const phan = await Promise.all(ids.slice(i, i + lo).map(async id => {
      const o = {nickname: m.get(id), link: "https://space.bilibili.com/" + id,
                 avatar: "", fans: 0, videos_count: 0, signature: ""};
      try {
        const a = await (await fetch("https://api.bilibili.com/x/relation/stat?vmid=" + id,
              {credentials: "include"})).json();
        o.fans = ((a || {}).data || {}).follower || 0;
      } catch (e) {}
      try {
        const b = await (await fetch("https://api.bilibili.com/x/space/navnum?mid=" + id,
              {credentials: "include"})).json();
        o.videos_count = ((b || {}).data || {}).video || 0;
      } catch (e) {}
      try {
        const c = await (await fetch(
              "https://api.bilibili.com/x/web-interface/card?mid=" + id,
              {credentials: "include"})).json();
        const k = ((c || {}).data || {}).card || {};
        if (k.name) o.nickname = k.name;
        o.avatar = k.face || "";
        o.signature = (k.sign || "").slice(0, 140);
      } catch (e) {}
      return o;
    }));
    ra.push(...phan);
  }
  return ra;
}
"""


def main():
    keyword = sys.argv[1] if len(sys.argv) > 1 else "影评"
    limit = int(os.environ.get("GOI_Y_LIMIT", "20"))
    headless = os.environ.get("GOI_Y_HEADLESS", "1") == "1"
    out_path = os.environ.get("GOI_Y_OUT") or os.path.join(
        THU_MUC_CRAWLER, "data", "bili", "_goi_y_kenh.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    import urllib.parse
    url = "https://search.bilibili.com/video?keyword=" + urllib.parse.quote(keyword)
    # ĐỌC profile từ MC_BROWSER_DATA_DIR (userData — nơi LOGIN lưu cookie bili), KHÔNG hardcode app-src/MediaCrawler:
    # login lưu userData/browser_data/bili_user_data_dir nhưng trước đây gợi-ý đọc app-src/MediaCrawler/browser_data
    # RỖNG → "chưa login" → 0 kênh. Cùng cơ chế MC_BROWSER_DATA_DIR như douyin core / mo_dang_nhap.
    _bd = os.environ.get("MC_BROWSER_DATA_DIR") or os.path.join(THU_MUC_CRAWLER, "browser_data")
    user_data_dir = os.path.join(_bd, "bili_user_data_dir")
    os.makedirs(user_data_dir, exist_ok=True)
    stealth_path = os.path.join(THU_MUC_CRAWLER, "libs", "stealth.min.js")

    creators = []
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=user_data_dir, headless=headless,
            viewport={"width": 1366, "height": 900}, user_agent=UA,
            ignore_default_args=["--enable-automation"],
            args=["--hide-crash-restore-bubble", "--no-first-run",
                  "--no-default-browser-check", "--disable-session-crashed-bubble"],
        )
        if os.path.exists(stealth_path):
            try:
                ctx.add_init_script(path=stealth_path)
            except Exception:
                pass
        page = ctx.new_page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
        except Exception:
            pass
        try:
            page.wait_for_selector('a[href*="space.bilibili.com"]', timeout=15000)
        except Exception:
            pass
        time.sleep(2)
        # cuộn để nạp thêm video ⇒ thêm UP. Số vòng theo `limit` vì mỗi trang ~30 video mà
        # nhiều video trùng chủ ⇒ số UP thu được luôn ÍT HƠN số video nhiều.
        for _ in range(max(3, min(10, (limit // 10) + 2))):
            try:
                page.mouse.wheel(0, 2200)
            except Exception:
                pass
            time.sleep(1.0)
        try:
            creators = page.evaluate(JS_TRICH, limit) or []
        except Exception:
            creators = []
        try:
            ctx.close()
        except Exception:
            pass

    creators.sort(key=lambda c: c.get("fans") or 0, reverse=True)
    creators = creators[:limit]
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(creators, f, ensure_ascii=False)
    print("BILI_GOI_Y_DONE", len(creators))


if __name__ == "__main__":
    main()
