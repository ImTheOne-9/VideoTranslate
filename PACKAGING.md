# Packaging notes

Project is prepared to run with local tools instead of relying on system PATH.

Include these paths when packaging:

- `server.js`
- `package.json`
- `package-lock.json`
- `node_modules/`
- `public/`
- `lib/`
- `tools/ffmpeg.exe`
- `tools/yt-dlp.exe`
- `tools/whisper.exe`
- `tools/whisper_models/base.pt`
- `tools/omnivoice/omnivoice-cli.exe` and the DLL files next to it if using OmniVoice voice cloning
- `tools/omnivoice/models/omnivoice-q8_0.gguf` or the configured GGUF model
- `python_engine/`
- `downloads/` and `uploads/` can be empty folders

Runtime behavior:

- YouTube download uses `tools/yt-dlp.exe`.
- FFmpeg processing uses `tools/ffmpeg.exe`.
- Whisper transcription first uses `python_engine/python.exe -m whisper.transcribe`.
- If `python_engine/python.exe` is missing, it falls back to `tools/whisper.exe`.
- Whisper uses local model directory `tools/whisper_models`, so `base.pt` is not downloaded again.
- OmniVoice voice cloning uses `tools/omnivoice/omnivoice-cli.exe`, `tools/omnivoice/models/omnivoice-q8_0.gguf`, saved reference audio, and the required `ref-text`.
- `tools/build_deps/` and `tools/omnivoice/src/` are only needed to rebuild OmniVoice, not to run packaged app.

Start command:

```powershell
npm start
```
