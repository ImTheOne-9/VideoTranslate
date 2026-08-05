const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('studio render uses the shared mastering graph and returns QC metadata', () => {
  const source = read('controllers/studioController.js');
  assert.match(source, /normalizeAudioMasteringConfig\(body\)/);
  assert.match(source, /buildAudioMixGraph\(\{/);
  assert.match(source, /duckingApplied/);
  assert.match(source, /final_mix_qc\.wav/);
  assert.match(source, /audioReport,/);
  assert.match(source, /audioTracks/);
  assert.match(source, /readPcm16WavFile\(chunk\.filePath\)/);
  assert.match(source, /targetFrame \* chunk\.blockAlign/);
  assert.doesNotMatch(source, /fadeMs|crossfadeMs|audioCrossfadeMs/);
  assert.doesNotMatch(source, /const fadeSamples =/);
  assert.doesNotMatch(source, /function readWavInfo/);
});

test('segment regeneration includes mastering settings in cache and fitted audio', () => {
  const source = read('controllers/segmentController.js');
  assert.match(source, /audioProcessing: voiceProcessing/);
  assert.match(source, /normalizationOptions: \{/);
  assert.doesNotMatch(source, /fadeMs|crossfadeMs|audioCrossfadeMs/);
});

test('audio mixer exposes automatic, off and custom mastering modes', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  assert.match(html, /name="audioMasteringMode"/);
  assert.match(html, /value="auto" selected/);
  assert.match(html, /value="off"/);
  assert.match(html, /value="custom"/);
  assert.match(html, /name="audioDucking"/);
  assert.match(html, /name="audioExportTracks"/);
  assert.doesNotMatch(html, /name="audioNoiseGate" value="true" checked/);
  assert.doesNotMatch(html, /name="audioDucking" value="true" checked/);
  assert.match(app, /function updateAudioMasteringUi/);
  assert.match(app, /renderAudioResultSummary/);
  assert.match(app, /function toggleAudioResultTracks/);
  assert.match(app, /audio-result-links" hidden/);
});
