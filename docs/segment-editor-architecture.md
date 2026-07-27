# Timeline Segment Editor

## Workflow

When `segmentReviewEnabled` is enabled for an OmniVoice render:

1. Source preparation, subtitle extraction, and translation finish normally.
2. `SegmentService` creates `work/segments/manifest.json` and `reviewed.srt`.
3. The render task enters `waiting_input` with `actionRequired: segment_review`.
4. The editor updates the manifest through revision-checked APIs.
5. Approval changes the manifest to `reviewStatus: approved`.
6. Resume uses `reviewed.srt`, reuses valid per-segment audio, then continues mix and export.

Tasks that do not enable review still receive a segment manifest for stable per-segment
voice checkpoints, but they continue without waiting.

## Manifest contract

```json
{
  "version": 1,
  "taskId": "task_123",
  "revision": 4,
  "reviewRequired": true,
  "reviewStatus": "pending",
  "sourceSignature": "sha256",
  "finalSignature": "sha256",
  "durationMs": 180000,
  "segments": [
    {
      "id": "seg_immutable_id",
      "sourceCueIds": ["1", "2"],
      "sourceText": "Source dialogue",
      "text": "Translated narration",
      "startMs": 0,
      "endMs": 2400,
      "voiceFile": "voice.wav",
      "engineId": "current-omnivoice",
      "locked": false,
      "approved": false,
      "status": "pending",
      "audioFile": null,
      "audioDurationMs": null,
      "audioSignature": null,
      "error": null,
      "warnings": []
    }
  ]
}
```

Segment IDs never depend on text or timestamps. Editing text or changing a voice
invalidates only that segment's audio. Editing timestamps preserves audio and changes
the reviewed subtitle timeline.

## API

- `GET /api/render-tasks/:taskId/segments`
- `PUT /api/render-tasks/:taskId/segments`
- `POST /api/render-tasks/:taskId/segments/replace`
- `POST /api/render-tasks/:taskId/segments/approve`
- `POST /api/render-tasks/:taskId/segments/:segmentId/regenerate`
- `GET /api/render-tasks/:taskId/segments/:segmentId/audio`

All writes require the current `revision`. Stale writes return
`SEGMENT_REVISION_CONFLICT`. File paths are resolved from trusted task and segment
metadata; clients cannot submit arbitrary paths.

## Checkpoint behavior

- Text or voice change: remove only the affected audio and mark it pending.
- Timestamp change: keep audio, update `reviewed.srt`, rerun timeline mix/export.
- Generated preview: reuse during render when text, voice, reference, engine, language,
  and synthesis settings still match.
- Application restart: preserve `segment_review` rather than converting it to a generic
  resume action.

Voice generation is protected by a shared lock across Studio render, Voice Cloner, and
segment preview so the same local engine cannot be loaded concurrently by these flows.
