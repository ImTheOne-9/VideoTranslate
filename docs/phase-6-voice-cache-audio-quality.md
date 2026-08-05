# Phan 6: Cache voice prompt va chuan hoa audio

## Muc tieu

- Giu OmniVoice model trong mot tien trinh server khi tao nhieu cau lien tiep.
- Tai su dung voice prompt khi file giong mau, transcript va tuy chon tien xu ly khong doi.
- Giu file audio goc cua moi segment de co the chay lai Smart Fit ma khong goi TTS.
- Chuan hoa tung file audio truoc khi ghep vao video.
- Phat hien audio im lang, qua nho hoac vo tieng va hien canh bao trong man hinh Duyet loi thoai.

## Luong xu ly

1. Voice engine uu tien `omnivoice-server-{device}.exe` dung voi backend da chon.
2. Server nap model mot lan va tiep nhan nhieu yeu cau qua localhost.
3. Reference prompt duoc cache trong bo nho theo:
   - duong dan file da canonical hoa;
   - kich thuoc va thoi gian sua file;
   - reference text;
   - tuy chon tien xu ly.
4. Neu bat dau lai app, doi model hoac doi backend, server cu dung va cache trong bo nho duoc tao lai.
5. Audio TTS goc duoc lu rieng. Smart Fit tao file fitted bang FFmpeg.
6. File fitted duoc dua ve PCM 16-bit, mono, 24 kHz; can loudness, gioi han peak va fade ngan o hai dau.
7. QC doc lai WAV, lu thong so vao manifest va dua canh bao len tung segment.

## Chinh sach fallback

- Neu server dung backend dang chon co san, engine dung server.
- Neu server chua co, engine van dung OmniVoice CLI cu de tranh lam hong may da cai dat.
- Chuyen tu GPU sang CPU chi xay ra khi nguoi dung da bat cho phep fallback CPU.
- Huy render se huy request hien tai va dung server dang chay.

## Chuan hoa audio

- Integrated loudness muc tieu: `-18 LUFS`.
- True peak muc tieu: `-1.5 dBTP`.
- Limiter bao ve peak sau khi ghep: `-1 dBFS`.
- Dinh dang segment: `24000 Hz`, mono, PCM 16-bit.
- Fade dau/cuoi: toi da `15 ms`.

Bo loc su dung cac filter chuan cua FFmpeg: `loudnorm`, `alimiter`, `aresample`,
`aformat` va `afade`.

## Canh bao QC

- `audio_silent`: gan nhu khong co tin hieu hoac hon 98% mau la im lang.
- `audio_clipping`: co du mau cham nguong PCM de co nguy co vo tieng.
- `audio_too_quiet`: RMS thap hon `-32 dBFS` nhung chua phai im lang.

Canh bao khong tu dong xoa audio. Nguoi dung van co the nghe lai, sua loi thoai,
doi giong va tao lai rieng segment.

## Test matrix

| Nhom | Truong hop |
| --- | --- |
| Cache | Hai cau cung model/backend chi khoi dong mot server |
| Cache | Doi CPU/Vulkan/CUDA thi dung session cu va tao session moi |
| Cache | Doi file mau, transcript hoac metadata file lam cache miss |
| Fallback | Khong tu chuyen CPU neu nguoi dung chua cho phep |
| WAV | Doc dung WAV 44-byte va WAV co metadata chunk mo rong |
| QC | Nhan dien im lang, clipping va am luong qua nho |
| Normalize | Luon co loudnorm, limiter, resample, mono va fade |
| Smart Fit | File raw khong bi sua; chi fitted bi tao lai |
| Manifest | QC duoc luu, bi xoa khi audio fitted het hieu luc |
| UI | Canh bao va RMS/Peak xuat hien tren dung segment |
| Render | Final mix dung limiter xac dinh, khong tu thay doi loudness dong |
| Packaging config | Khai bao du ba server binary, nhung khong chay dong goi |
