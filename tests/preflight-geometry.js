process.env.GOOGLE_CLIENT_ID = 'x';
process.env.GOOGLE_CLIENT_SECRET = 'x';
process.env.COOKIE_SECRET = 'x'.repeat(64);
process.env.FLOW_SHARED_SECRET = 'y'.repeat(64);
process.env.DATA_ROOT = '/tmp/pp-test';

const pf = require('../webapp/src/preflight');

const CASES = [
  ['poster-300dpi.png', 'image/png', 36, '10800x8100 landscape 4:3 — the ideal case'],
  ['poster-300dpi.png', 'image/png', 42, 'same file on the 42" roll'],
  ['screenshot.jpg', 'image/jpeg', 36, '1920x1080 screenshot — should FAIL on DPI'],
  ['slide-16x9.png', 'image/png', 36, '3840x2160 16:9 slide'],
  ['portrait.png', 'image/png', 36, '5400x7200 portrait — short side is WIDTH'],
  ['poster-48x36.pdf', 'application/pdf', 36, 'true 48x36in PDF, vector'],
  ['slide-letter.pdf', 'application/pdf', 36, '13.3x7.5in slide PDF — enlargement warning'],
];

(async () => {
  for (const [file, mime, roll, note] of CASES) {
    const r = await pf.preflight(`/home/claude/fixtures/${file}`, {
      mime, filename: file, rollWidthIn: roll, fitMode: 'fit_roll', byteSize: 1000,
    });
    const L = r.layout, R = r.raster;
    console.log(`\n${'─'.repeat(74)}`);
    console.log(`${file}  on ${roll}" roll`);
    console.log(`   ${note}`);
    console.log(`   verdict      ${r.severity.toUpperCase()}`);
    console.log(`   source       ${r.source.kind} ${r.source.widthPx ? r.source.widthPx + 'x' + r.source.heightPx + 'px' : ''}` +
      `${r.source.nativeWidthIn ? ` ${r.source.nativeWidthIn.toFixed(1)}x${r.source.nativeHeightIn.toFixed(1)}in` : ''}`);
    console.log(`   finished     ${L.finishedWidthIn}" x ${L.finishedHeightIn}"  (${L.orientation})`);
    console.log(`   across roll  ${L.acrossRollIn}"  of ${L.printableWidthIn}" printable`);
    console.log(`   paper used   ${L.printLengthIn}"  (${L.areaSqFt} sq ft)`);
    console.log(`   raster       ${R.widthPx}x${R.heightPx}px  ${R.megapixels}MP  @${R.targetDpi}dpi`);
    console.log(`   effective    ${R.effectiveDpi} DPI   enlargement ${R.enlargement}x`);
    for (const i of r.issues) console.log(`   [${i.severity}] ${i.code}: ${i.message}`);
  }

  // Regression check: the bug in the original script.
  console.log(`\n${'═'.repeat(74)}`);
  console.log('REGRESSION — 48x36 landscape poster on a 36" roll');
  const r = await pf.preflight('/home/claude/fixtures/poster-48x36.pdf', {
    mime: 'application/pdf', filename: 'p.pdf', rollWidthIn: 36, byteSize: 1,
  });
  const ok = Math.abs(r.layout.finishedHeightIn - 35.5) < 0.1 &&
             Math.abs(r.layout.finishedWidthIn - 47.33) < 0.5;
  console.log(`  old logic would give: 36" wide x 27" tall  (wrong — shrinks the poster)`);
  console.log(`  new logic gives:      ${r.layout.finishedWidthIn}" wide x ${r.layout.finishedHeightIn}" tall`);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} — the 36" side runs across the roll, 47" feeds out`);
})();
