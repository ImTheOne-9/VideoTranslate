const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSubtitleFontMeasurer,
  escapePangoMarkup,
  heuristicWidth,
  tokenizeMeasurementText
} = require('../lib/subtitle-font-measurer');

test('font measurer escapes markup and tokenizes whitespace safely', () => {
  assert.equal(escapePangoMarkup('A&B <C>'), 'A&amp;B &lt;C&gt;');
  assert.deepEqual(tokenizeMeasurementText('  Xin   chào  '), ['Xin', ' ', 'chào']);
  assert.ok(heuristicWidth('WWW', 40) > heuristicWidth('iii', 40));
});

test('font measurer uses rendered metadata and scales widths to the requested size', async () => {
  const fakeSharp = ({ text }) => ({
    metadata: async () => ({
      width: Array.from(text.text).reduce((sum, char) => sum + (char === 'W' ? 100 : 20), 0)
    })
  });
  const measurer = await createSubtitleFontMeasurer(['WWW', 'iii'], {
    fontName: 'Arial',
    sharpImpl: fakeSharp
  });

  assert.equal(measurer.provider, 'sharp-pango');
  assert.ok(measurer.measuredTokens >= 5);
  assert.ok(measurer.measureText('WWW', 50) > measurer.measureText('iii', 50));
  assert.equal(measurer.measureText('WWW', 50), 150);
});
