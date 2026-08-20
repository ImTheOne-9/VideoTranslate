'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const studioController = fs.readFileSync(path.join(root, 'controllers', 'studioController.js'), 'utf8');
const voiceController = fs.readFileSync(path.join(root, 'controllers', 'voiceController.js'), 'utf8');
const sharedState = fs.readFileSync(path.join(root, 'lib', 'shared-state.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const libraryModule = fs.readFileSync(path.join(root, 'public', 'js', 'library-module.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('studio render resolves the configured voice engine instead of invoking OmniVoice CLI directly', () => {
  assert.match(studioController, /voiceEngineRegistry\.resolve\(voiceEngineId, DEFAULT_VOICE_ENGINE_ID\)/);
  assert.match(studioController, /const runVoiceEngine = async \(options, selectedEngine = voiceEngine\)/);
  assert.match(studioController, /selectedEngine\[method\]\(/);
  assert.doesNotMatch(studioController, /shared\.runOmnivoiceCLI/);
  assert.match(studioController, /voiceExecution/);
});

test('studio render enables adaptive cue narration and automatic Edge rescue by default', () => {
  assert.match(studioController, /body\.narrationPipeline !== 'legacy'/);
  assert.match(studioController, /srtArray\.map\(\(item\) => \[item\]\)/);
  assert.match(studioController, /synthesizeWithFallback/);
  assert.match(studioController, /evaluateCoverage\(groups\.length, voiceChunks\.length\)/);
  assert.match(html, /name="narrationPipeline" value="adaptive"/);
});

test('voice engine fallback requires explicit user opt-in', () => {
  assert.match(sharedState, /behavior\.allowCpuFallback === true/);
  assert.match(sharedState, /if \(allowCpuFallback && omiDevice && omiDevice !== 'cpu'\)/);
  assert.match(studioController, /body\.voiceAllowCpuFallback/);
  assert.match(voiceController, /req\.body\.allowCpuFallback/);
});

test('voice engine discovery is exposed through API and studio assets', () => {
  assert.match(server, /app\.get\('\/api\/voice-engines', voiceController\.getVoiceEngines\)/);
  assert.match(voiceController, /getVoiceEngines: async/);
  assert.match(studioController, /voiceEngines = await voiceEngineRegistry\.describeAll\(\)/);
  assert.match(studioController, /defaultVoiceEngineId: DEFAULT_VOICE_ENGINE_ID/);
});

test('studio UI exposes engine selection, capabilities, and CPU fallback control', () => {
  assert.match(html, /id="voice-engine-select" name="voiceEngine"/);
  assert.match(html, /id="voice-engine-capabilities"/);
  assert.match(html, /id="voice-allow-cpu-fallback" name="voiceAllowCpuFallback"/);
  assert.match(app, /function renderVoiceEngineOptions/);
  assert.match(app, /assets\.voiceEngines/);
  assert.match(app, /Voice engine đã chọn chưa sẵn sàng/);
});

test('packaging includes persistent OmniVoice server variants', () => {
  const filters = packageJson.build.extraResources.flatMap((resource) => resource.filter || []);
  assert.ok(filters.includes('omnivoice/omnivoice-server-*.exe'));
});

test('Edge TTS is independent from OmniVoice model, reference audio, and GPU controls', () => {
  assert.match(studioController, /supportsVoiceCloning && refAudioPath/);
  assert.match(studioController, /voiceEngine\.id === 'edge-tts'[\s\S]*\? 'cpu'/);
  assert.match(studioController, /voiceEngine\.id === 'piper'[\s\S]*\? piperDevice/);
  assert.match(app, /selectedDescriptor\?\.status\?\.ready !== true/);
  assert.match(app, /voice-device-group/);
  assert.match(libraryModule, /const isEdge = engineId === 'edge-tts'/);
  assert.match(libraryModule, /refAudio\.required = !isEdge/);
  assert.match(voiceController, /supportsVoiceCloning && \(!refAudio \|\| !refText\)/);
});

test('studio render logs the actual voice engine and Edge synthesis settings', () => {
  assert.match(studioController, /voiceEngine\.id === 'piper' \? 'Piper' : 'OmniVoice'/);
  assert.match(studioController, /\[\$\{voiceLogTag\}-Sub\]/);
  assert.match(studioController, /Voice: \$\{voiceForGroup\(idx\)\}, Rate: \$\{edgeRate\}, Pitch: \$\{edgePitch\}/);
  assert.doesNotMatch(studioController, /\[OmniVoice-Sub\]/);
});
