# -*- coding: utf-8 -*-
"""TIẾN ĐỘ TẢI VIDEO cho nhánh MediaCrawler (Douyin / Bilibili).

🔴 VÌ SAO CÓ (19/08/2026 — chủ dự án: *"làm nhiều cách để họ tưởng không bị treo"*):
`store/*/…_store_media.py` chỉ log SAU KHI video đã ghi xong (`save video … success`).
Nghĩa là trong suốt lúc tải một video 300–600MB, tiến trình cào **không in một dòng nào**.
Khách nhìn màn hình đứng im hàng phút → tưởng treo → bấm Dừng → mất cả lượt cào.
Đây đúng khiếu nại thứ tư trong `NGHIEP-VU` §1bis ("lỗi vặt/treo/phải làm lại").

Nhánh yt-dlp đã có sẵn hook in `📥 Đang tải video: N% của XMB (Y MB/s)` (tai_ytdlp.py).
File này là bản tương đương cho nhánh MediaCrawler, **in CÙNG ĐỊNH DẠNG** để UI chỉ phải
hiểu MỘT kiểu dòng thay vì hai.

📌 IN THẲNG `print("LOG:…")`, KHÔNG qua `utils.logger`:
`web_app._crawl_worker` đã có sẵn nhánh `if d.startswith("LOG:") → them_log(...)`. Đi đúng
đường đó thì **không phải đụng gì** vào bộ phân loại 90-mẫu của nó — thêm tiến độ mà không
tăng bề mặt chẩn đoán.

📌 GỘP NHIỀU VIDEO LÀM MỘT DÒNG: `MC_DL_CONCURRENCY` mặc định 2 ⇒ hai video tải song song.
Nếu mỗi video tự in `%` riêng thì khách thấy số **nhảy qua nhảy lại** (45% → 12% → 48%) và
tưởng tool đếm sai. Nên gộp: một dòng tổng cho tất cả video đang tải.
(Bilibili còn chia MỘT video thành 4 đoạn tải song song — cùng lý do, 4 đoạn dồn vào 1 khoá.)

Tắt hẳn: env `MC_TIENDO=0`.
"""
import os
import threading
import time

_BUOC_PCT = 5        # in khi phần trăm nhảy đủ 5 điểm…
_MOI_GIAY = 8.0      # …hoặc khi đã im lặng đủ 8 giây (dù % chưa nhảy) — để khách luôn thấy còn sống


def _bat():
    return os.environ.get("MC_TIENDO", "1") != "0"


class _So:
    """Sổ chung của MỌI video đang tải trong tiến trình này."""

    def __init__(self):
        self.khoa = threading.Lock()   # store chạy trong asyncio 1 luồng, nhưng bilibili có thread phụ → cứ khoá
        self.muc = {}                  # ma -> {"da": byte đã nhận, "tong": byte tổng (0 = chưa biết)}
        self.t_in = 0.0                # lần in gần nhất
        self.pct_in = -1               # phần trăm lần in gần nhất
        self.t0 = 0.0                  # mốc bắt đầu lượt tải hiện tại (để tính MB/s)
        self.byte0 = 0                 # số byte tại mốc t0
        # 🔴 04/09/2026 — BA SỐ ĐỀU SAI, đo thật khi cào 1 video Bilibili 446MB:
        #   in ra "68% của 32MB (0.2MB/s)" trong khi thật là 446MB ở 2.9MB/s.
        #   · TỔNG sai: `tong` chỉ cộng các mục ĐANG MỞ. Bilibili chia file thành khối 8MB
        #     (`MC_BILI_CHUNK_MB`) chạy 4 khối song song ⇒ tổng luôn = 4×8 = **32MB**, tức KÍCH THƯỚC
        #     CỬA SỔ ĐANG TẢI chứ không phải file. Thấy "24MB" là lúc chỉ 3 khối đang mở.
        #   · PHẦN TRĂM TỤT LÙI: `dong()` XOÁ mục khỏi sổ ⇒ byte của khối vừa xong biến mất khỏi TỬ SỐ
        #     ⇒ % rơi. Đo được **9 lần tụt** (94%→14%) trong một video. Douyin nhẹ hơn nhưng CÙNG BỆNH
        #     (đo: 3 lần tụt) vì nó tải 2 video song song, video xong là rời sổ.
        #   · TỐC ĐỘ: `t0` chỉ đặt lại khi sổ RỖNG HẲN. Bilibili có khối gối đầu liên tục nên sổ không
        #     bao giờ rỗng ⇒ `t0` đứng nguyên từ giây đầu ⇒ in ra TRUNG BÌNH TỪ ĐẦU LƯỢT, tụt dần về 0.
        # ⇒ Cộng dồn theo VIDEO (giữ byte của khối đã xong) + lấy TỔNG THẬT của file + đo tốc độ trên
        #   CỬA SỔ TRƯỢT. Không "kẹp cho khỏi tụt": làm thế là giấu bệnh chứ không chữa.
        self.file_tong = {}            # vid -> dung lượng THẬT của file (0 = chưa biết)
        self.file_da = {}              # vid -> byte của các khối ĐÃ XONG (giữ lại sau khi `dong()`)
        self.mau = []                  # [(thời điểm, tổng byte)] — cửa sổ trượt để tính MB/s

    def _in_neu_can(self, ep=False):
        """Gọi TRONG khoá. ep=True: in ngay (mở/đóng một video)."""
        if not self.muc:
            return
        # Byte = khối ĐÃ XONG (giữ lại) + khối đang mở ⇒ KHÔNG BAO GIỜ tụt vì có khối kết thúc.
        da = sum(self.file_da.values()) + sum(m["da"] for m in self.muc.values())
        # Tổng = dung lượng THẬT của các file đang tải. Chưa biết (server không khai) thì mới lùi về
        # cách cũ — lúc đó số có thể vẫn nhảy, nhưng đó là hết thông tin chứ không phải lỗi tính.
        if self.file_tong and all(self.file_tong.values()):
            tong = sum(self.file_tong.values())
        else:
            tong = sum(self.file_da.values()) + sum(m["tong"] for m in self.muc.values())
        now = time.time()
        pct = int(da * 100 / tong) if tong > 0 else -1
        if pct > 100:
            pct = 100     # server khai Content-Length thiếu (đã gặp ở Douyin: khai thừa/thiếu) → đừng in 137%
        if not ep:
            du_moc = (pct >= 0 and pct >= self.pct_in + _BUOC_PCT)
            du_gio = (now - self.t_in) >= _MOI_GIAY
            if not (du_moc or du_gio):
                return
        self.t_in = now
        if pct >= 0:
            self.pct_in = pct
        # TỐC ĐỘ TRÊN CỬA SỔ TRƯỢT ~12s, KHÔNG phải trung bình từ đầu lượt: video dài tải 10 phút thì
        # trung bình-từ-đầu luôn thấp hơn tốc độ thật rất nhiều và cứ tụt dần — khách đọc tưởng máy chậm.
        self.mau.append((now, da))
        while len(self.mau) > 2 and now - self.mau[0][0] > 12.0:
            self.mau.pop(0)
        _t_dau, _b_dau = self.mau[0]
        _dt = now - _t_dau
        spd = ((da - _b_dau) / _dt / 1048576.0) if _dt >= 0.5 else \
              ((da - self.byte0) / max(0.001, now - self.t0) / 1048576.0)
        # ĐẾM THEO VIDEO, KHÔNG theo khoá: Bilibili chia MỘT video thành 4 đoạn tải song song (4 khoá) —
        # đếm khoá sẽ in "Đang tải 4 video" trong khi thực tế chỉ có 1. Khoá dạng "<vid>#<đoạn>".
        n = len({m["vid"] for m in self.muc.values()})
        nhan = "Đang tải video" if n <= 1 else ("Đang tải %d video" % n)
        if tong > 0:
            print("LOG:📥 %s: %d%% của %.0fMB (%.1fMB/s)" % (nhan, pct, tong / 1048576.0, spd), flush=True)
        else:
            # Server không khai Content-Length → không có % nào để nói. Vẫn PHẢI in: mục đích số một của
            # dòng này là chứng minh "còn sống", con số % chỉ là phần thưởng thêm.
            print("LOG:📥 %s: %.0fMB (%.1fMB/s)" % (nhan, da / 1048576.0, spd), flush=True)

    def _in_xong(self, tong):
        """In dòng **100%** CUỐI CÙNG cho video vừa tải xong. Gọi TRONG khoá.

        🔴 09/09/2026 — chủ dự án: *"sao cào video về bị treo ở 99%"*. Hai chỗ cùng chặn dòng cuối:
          · bước in là 5 điểm (`_BUOC_PCT`) ⇒ từ 99% phải tới 104% mới in — không bao giờ tới;
          · `_in_neu_can` mở đầu bằng `if not self.muc: return`, mà lúc video xong thì MỌI khối đã đóng,
            và `dong()` trước đây không ép in.
        ⇒ Con số cuối UI nhận được luôn là 95–99%. Tab "Theo link" lấy thẳng số đó làm phần trăm
          (`index.html`: `p2 = subPct` khi chỉ có 1 video) nên thanh **đứng nguyên ở 99%** suốt các khâu
          SAU: ghép hình+tiếng, ghi đĩa, đổi H.265→H.264.
        ĐO THẬT 09/09 (Bilibili 441MB, 1 video): dòng `99%` lúc 145,7s — `save video success` mãi 159,4s.

        🔴 CHỈ IN KHI SỔ CÒN ĐÚNG MỘT VIDEO (điều kiện ở `dong()`). Douyin chạy `MC_DL_CONCURRENCY=2`:
          video A xong trong khi B mới 40% mà in "100%" thì UI (chỉ-cho-tiến) đẩy thanh lên 100% SAI.
        """
        if not _bat():
            return
        # In có try RIÊNG: `print` emoji trên console cp1258 từng làm câm cả tính năng khác (memory
        # `cau-log-song-chung-try-voi-logic`). Hỏng dòng log KHÔNG được phép ảnh hưởng lượt tải.
        try:
            print("LOG:📥 Đang tải video: 100%% của %.0fMB — xong phần tải, đang xử lý tiếp…"
                  % (tong / 1048576.0), flush=True)
            self.pct_in = 100
        except Exception:
            pass

    def mo(self, khoa, vid, tong=0, tong_file=0):
        with self.khoa:
            # 🐛 ĐIỀU KIỆN CŨ `not self.file_da` SAI — lưới bắt được: video tải HỎNG giữa chừng thì
            #   `file_da` của nó KHÔNG BAO GIỜ đạt `file_tong`, nên nhánh dọn ở `dong()` không chạy,
            #   và `file_da` mãi khác rỗng ⇒ điều kiện này mãi False ⇒ mục kẹt lại VĨNH VIỄN.
            #   Đo: A hỏng ở 40/100MB, sau đó B (50MB) in ra "60% của 150MB" thay vì "100% của 50MB".
            # ⇒ Mốc LƯỢT MỚI đúng là: không còn khối nào đang chạy VÀ video này CHƯA từng có trong sổ.
            #   Không dùng mỗi `not self.muc`: Bilibili có lúc 4 khối cùng đóng trước khi khối kế mở,
            #   sổ rỗng TẠM THỜI giữa lúc tải — dọn ở đó là quay lại đúng con bug đã sửa lúc chiều.
            if not self.muc and vid not in self.file_tong:
                self.t0 = time.time()
                self.byte0 = 0
                self.pct_in = -1
                self.mau = []
                self.file_tong = {}
                self.file_da = {}
            self.muc.setdefault(khoa, {"da": 0, "tong": 0, "vid": vid})
            if tong:
                self.muc[khoa]["tong"] = int(tong)
            self.file_da.setdefault(vid, 0)
            # Giữ giá trị LỚN NHẤT: khối đầu (probe 1MB) khai total nhỏ hơn, khối sau khai đủ.
            if tong_file and int(tong_file) > self.file_tong.get(vid, 0):
                self.file_tong[vid] = int(tong_file)

    def dat_tong(self, khoa, tong):
        with self.khoa:
            if khoa in self.muc and tong and tong > 0:
                self.muc[khoa]["tong"] = int(tong)

    def dat_da(self, khoa, n):
        """Đặt số byte đã nhận theo giá trị TUYỆT ĐỐI.

        Vì sao cần bản tuyệt đối chứ không chỉ `them(delta)`: cả Douyin lẫn Bilibili đều có RESUME —
        khi server bỏ qua Range và trả lại từ đầu, code gọi `buf.clear()` rồi nạp lại. Cộng dồn delta ở
        đó sẽ đếm TRÙNG phần đã tải (in ra 180% rồi tụt). Báo `len(buf)` tuyệt đối thì luôn đúng."""
        with self.khoa:
            m = self.muc.get(khoa)
            if m is None:
                return
            n = max(0, int(n))
            if n == m["da"]:
                return
            m["da"] = n
            self._in_neu_can()

    def them(self, khoa, n):
        if n <= 0:
            return
        with self.khoa:
            m = self.muc.get(khoa)
            if m is None:
                return
            m["da"] += int(n)
            self._in_neu_can()

    def dong(self, ma):
        with self.khoa:
            m = self.muc.pop(ma, None)
            if m is None:
                return
            # GIỮ byte của khối vừa xong — xoá trắng là nguyên nhân % tụt lùi (xem chú thích `__init__`).
            vid = m["vid"]
            self.file_da[vid] = self.file_da.get(vid, 0) + int(m.get("da") or 0)
            # 🐛 BẢN VÁ ĐẦU CỦA TÔI DỌN NGAY KHI `muc` RỖNG — SAI, và lưới bắt được: 4 khối song song
            #   THƯỜNG cùng kết thúc một nhịp TRƯỚC khi khối kế kịp mở, nên `muc` rỗng TẠM THỜI liên tục.
            #   Dọn ở đó = xoá sạch byte đã cộng dồn ⇒ % vẫn tụt (13 lần) và kết thúc ở 6%.
            #   ⇒ Chỉ gỡ một video khi nó THẬT SỰ ĐỦ BYTE và không còn khối nào của nó đang mở.
            con_mo = any(x["vid"] == vid for x in self.muc.values())
            tf = self.file_tong.get(vid, 0)
            if (not con_mo) and tf and self.file_da.get(vid, 0) >= tf:
                # Dòng 100% cuối — CHỈ khi đây là video DUY NHẤT còn trong sổ (xem `_in_xong`).
                if not self.muc and len(self.file_tong) == 1:
                    self._in_xong(tf)
                self.file_da.pop(vid, None)
                self.file_tong.pop(vid, None)
            # Đường lùi cho ca KHÔNG biết dung lượng thật (server không khai): giữ nguyên hành vi cũ,
            # dọn khi sổ rỗng — thà số nhảy còn hơn cộng dồn vô hạn qua nhiều video.
            if not self.muc and not any(self.file_tong.values()):
                self.file_tong = {}
                self.file_da = {}
                self.mau = []


_SO = _So()


class TienDo:
    """Handle của MỘT video. Dùng như context manager:

        with TienDo("aweme_123") as td:
            td.dat_tong(content_length)
            ... td.them(len(chunk)) ...

    Mọi lời gọi đều nuốt lỗi: đây là tính năng HIỂN THỊ, không được phép làm hỏng lượt tải.
    """

    def __init__(self, ma, doan="", tong=0, tong_file=0):
        """`tong` = dung lượng KHỐI này · `tong_file` = dung lượng CẢ FILE (để in đúng tổng).
        Nền tảng nào chia file thành nhiều khối (Bilibili) BẮT BUỘC truyền `tong_file`, không thì
        thanh tiến độ chỉ thấy cửa sổ đang tải — xem chú thích ở `_So.__init__`."""
        self.vid = str(ma or id(self))
        self.ma = self.vid + "#" + str(doan)
        self.bat = _bat()
        if self.bat:
            try:
                _SO.mo(self.ma, self.vid, tong, tong_file)
            except Exception:
                self.bat = False

    def dat_tong(self, tong):
        if self.bat:
            try:
                _SO.dat_tong(self.ma, tong)
            except Exception:
                pass

    def dat_da(self, n):
        if self.bat:
            try:
                _SO.dat_da(self.ma, n)
            except Exception:
                pass

    def them(self, n):
        if self.bat:
            try:
                _SO.them(self.ma, n)
            except Exception:
                pass

    def dong(self):
        if self.bat:
            try:
                _SO.dong(self.ma)
            except Exception:
                pass
            self.bat = False

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.dong()
        return False
