'use strict';
/**
 * ============================================================================
 *  RENDER ENGINE
 * ============================================================================
 *  Everything converges on a single print-ready PNG at exact pixel dimensions
 *  with the correct density tag, plus a small preview and thumbnail.
 *
 *  Conversion routes:
 *      .pptx/.ppt/.odp  --LibreOffice-->  PDF  --pdftoppm-->  PNG
 *      .html            --Chromium----->  PDF  --pdftoppm-->  PNG
 *      .pdf             ------------------------pdftoppm-->  PNG
 *      .png/.jpg/.tif   ------------------------sharp------>  PNG
 *
 *  HTML and Office both route through PDF on purpose: the page stays vector
 *  all the way to the final rasterisation, so a Claude-built HTML poster comes
 *  out as sharp at 300 DPI as it would at 1200. Screenshotting the DOM at
 *  12,600 px instead would hit Chromium's texture limits and rasterise text.
 * ============================================================================
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const sharp = require('sharp');
const config = require('./config');
const storage = require('./storage');

// A 227 MP poster is ~400 MB of raw pixels. Don't let libvips also hold a cache.
sharp.cache(false);
sharp.concurrency(1);
sharp.simd(true);

function run(bin, args, { timeout = config.pipeline.convertTimeoutMs, cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, {
      timeout, cwd, maxBuffer: 16 << 20,
      env: { ...process.env, ...env },
      killSignal: 'SIGKILL',
    }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${path.basename(bin)} failed: ${err.message}\n${String(stderr).slice(0, 2000)}`;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
    child.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Office -> PDF
// ---------------------------------------------------------------------------
/**
 * LibreOffice is single-instance per user profile. Give every conversion its
 * own throwaway profile so two jobs can convert at once instead of one
 * silently returning nothing.
 */
async function officeToPdf(srcPath, workDir) {
  const profile = path.join(workDir, 'lo-profile');
  await fsp.mkdir(profile, { recursive: true });
  // LibreOffice insists on the original extension to pick a filter.
  const staged = path.join(workDir, `src${path.extname(srcPath) || '.pptx'}`);
  await fsp.copyFile(srcPath, staged);

  await run(config.pipeline.sofficeBin, [
    '--headless', '--norestore', '--nolockcheck', '--nodefault', '--nofirststartwizard',
    `-env:UserInstallation=file://${profile}`,
    '--convert-to', 'pdf:impress_pdf_Export',
    '--outdir', workDir, staged,
  ], { timeout: config.pipeline.convertTimeoutMs, cwd: workDir });

  const out = path.join(workDir, 'src.pdf');
  await fsp.access(out).catch(() => {
    throw new Error('LibreOffice produced no PDF — the file may use an unsupported feature');
  });
  return out;
}

// ---------------------------------------------------------------------------
// HTML -> PDF
// ---------------------------------------------------------------------------
/**
 * Print the page to a PDF sized exactly to the finished poster, so the
 * author's CSS lays out against real inches.
 */
async function htmlToPdf(srcPath, workDir, { widthIn, heightIn }) {
  const html = await fsp.readFile(srcPath, 'utf8');
  // Inject the page size ahead of the author's own styles so theirs can win
  // if they set @page deliberately.
  const shim = `<style id="pp-page-size">@page{size:${widthIn}in ${heightIn}in;margin:0}
html,body{margin:0;padding:0;width:${widthIn}in;height:${heightIn}in;overflow:hidden}
*{-webkit-print-color-adjust:exact;print-color-adjust:exact}</style>`;
  const patched = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (m) => m + shim)
    : shim + html;

  const staged = path.join(workDir, 'page.html');
  await fsp.writeFile(staged, patched, 'utf8');

  const out = path.join(workDir, 'page.pdf');
  await run(config.pipeline.chromiumBin, [
    // Chrome insists on a writable profile directory. Running as a service
    // account there may be no usable HOME, and two concurrent conversions
    // sharing the default profile will fight over its lock — so each
    // conversion gets a throwaway one inside its own work dir, the same way
    // LibreOffice does above.
    `--user-data-dir=${path.join(workDir, 'chrome-profile')}`,
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--no-pdf-header-footer', '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=20000',
    '--font-render-hinting=none',
    `--print-to-pdf=${out}`,
    `file://${staged}`,
  ], { timeout: 90000, cwd: workDir });

  await fsp.access(out).catch(() => { throw new Error('Chromium produced no PDF'); });
  return out;
}

// ---------------------------------------------------------------------------
// PDF -> PNG
// ---------------------------------------------------------------------------
async function pdfToPng(pdfPath, workDir, { widthPx, heightPx, page = 1 }) {
  const base = path.join(workDir, `page${page}`);
  const args = ['-png', '-singlefile', '-f', String(page), '-l', String(page),
    '-scale-to-x', String(widthPx), '-scale-to-y', String(heightPx),
    '-aa', 'yes', '-aaVector', 'yes', pdfPath, base];
  await run(config.pipeline.pdftoppmBin, args);
  const out = `${base}.png`;
  await fsp.access(out).catch(() => { throw new Error('pdftoppm produced no image'); });
  return out;
}

/** Normalise anything to a PDF when one is needed. Returns null for rasters. */
async function toPdfIfPossible(srcAbs, srcKind, workDir, layout) {
  if (srcKind === 'pdf') return srcAbs;
  if (srcKind === 'office') return officeToPdf(srcAbs, workDir);
  if (srcKind === 'html') {
    return htmlToPdf(srcAbs, workDir, {
      widthIn: layout.finishedWidthIn, heightIn: layout.finishedHeightIn,
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public: build the print-ready raster
// ---------------------------------------------------------------------------
/**
 * @returns {{absPath, relPath, widthPx, heightPx, densityDpi, byteSize}}
 */
async function buildPrintRaster(job, originalAbs, srcKind, layout, raster) {
  const work = await storage.tempDir(`print-${job.public_id}`);
  try {
    const pdf = await toPdfIfPossible(originalAbs, srcKind, work, layout);
    let flatAbs;

    if (pdf) {
      flatAbs = await pdfToPng(pdf, work, {
        widthPx: raster.widthPx, heightPx: raster.heightPx, page: 1,
      });
    } else {
      flatAbs = originalAbs;
    }

    // Format matters more than it looks. A 42x36 poster is 151 megapixels.
    // Measured on that raster with photographic (incompressible) content:
    //
    //   PNG level 6      26s    407 MB
    //   TIFF deflate     22s    341 MB
    //   JPEG q95 4:4:4   25s     89 MB
    //
    // PNG is the honest default: lossless, and line art and small type on a
    // large-format print are exactly where JPEG ringing shows. But a
    // photo-heavy 400 MB file has to cross the network and then be decoded by
    // GDI+ on the print host, so sites that print mostly photographs can set
    // PRINT_FORMAT=jpeg and take a 4.5x size cut that is invisible at arm's
    // length. Chroma subsampling stays off either way — 4:2:0 smears coloured
    // text edges, which is the one artefact people do notice on a poster.
    const fmt = config.print.printFormat === 'jpeg' ? 'jpeg' : 'png';
    const ext = fmt === 'jpeg' ? 'jpg' : 'png';
    const staged = path.join(work, `print.${ext}`);

    let s = sharp(flatAbs, { limitInputPixels: false, sequentialRead: true })
      .rotate()                                   // honour EXIF, then drop it
      .resize(raster.widthPx, raster.heightPx, {
        fit: 'fill',                              // dims already match the aspect
        kernel: sharp.kernel.lanczos3,
        withoutEnlargement: false,
      })
      .flatten({ background: '#ffffff' })          // transparency -> paper white
      .toColorspace('srgb')
      .withMetadata({ density: raster.targetDpi }); // the driver reads this

    s = fmt === 'jpeg'
      ? s.jpeg({ quality: config.print.jpegQuality, chromaSubsampling: '4:4:4', mozjpeg: false })
      : s.png({ compressionLevel: 6, adaptiveFiltering: false, palette: false });

    await s.toFile(staged);

    const written = await storage.writeRendition(job.public_id, `print.${ext}`, staged);
    return {
      absPath: written.absPath, relPath: written.relPath,
      widthPx: raster.widthPx, heightPx: raster.heightPx,
      densityDpi: raster.targetDpi, byteSize: written.byteSize,
      mime: fmt === 'jpeg' ? 'image/jpeg' : 'image/png',
    };
  } finally {
    await storage.rmrf(work);
  }
}

// ---------------------------------------------------------------------------
// Public: build preview + thumbnail (fast path, runs on upload)
// ---------------------------------------------------------------------------
async function buildPreview(job, originalAbs, srcKind, layout) {
  const work = await storage.tempDir(`prev-${job.public_id}`);
  try {
    const maxPx = config.print.previewMaxPx;
    // Preview keeps the finished aspect ratio so the printer mock-up is honest.
    const ratio = layout.finishedWidthIn / layout.finishedHeightIn;
    const pw = ratio >= 1 ? maxPx : Math.round(maxPx * ratio);
    const ph = ratio >= 1 ? Math.round(maxPx / ratio) : maxPx;

    const pdf = await toPdfIfPossible(originalAbs, srcKind, work, layout);
    const flatAbs = pdf
      ? await pdfToPng(pdf, work, { widthPx: pw, heightPx: ph, page: 1 })
      : originalAbs;

    const previewStaged = path.join(work, 'preview.jpg');
    await sharp(flatAbs, { limitInputPixels: false, sequentialRead: true })
      .rotate()
      .resize(pw, ph, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
      .flatten({ background: '#ffffff' })
      .toColorspace('srgb')
      .jpeg({ quality: 82, mozjpeg: true, chromaSubsampling: '4:4:4' })
      .toFile(previewStaged);

    const thumbStaged = path.join(work, 'thumb.jpg');
    const tw = ratio >= 1 ? config.print.thumbMaxPx : Math.round(config.print.thumbMaxPx * ratio);
    const th = ratio >= 1 ? Math.round(config.print.thumbMaxPx / ratio) : config.print.thumbMaxPx;
    await sharp(previewStaged).resize(tw, th, { fit: 'fill' })
      .jpeg({ quality: 74, mozjpeg: true }).toFile(thumbStaged);

    const preview = await storage.writeRendition(job.public_id, 'preview.jpg', previewStaged);
    const thumb = await storage.writeRendition(job.public_id, 'thumb.jpg', thumbStaged);

    return {
      preview: { ...preview, widthPx: pw, heightPx: ph, mime: 'image/jpeg' },
      thumb: { ...thumb, widthPx: tw, heightPx: th, mime: 'image/jpeg' },
    };
  } finally {
    await storage.rmrf(work);
  }
}

/** Confirm every external binary exists before we accept traffic. */
async function checkToolchain() {
  const checks = [
    ['LibreOffice', config.pipeline.sofficeBin, ['--version']],
    ['pdftoppm', config.pipeline.pdftoppmBin, ['-v']],
    ['pdfinfo', config.pipeline.pdfinfoBin, ['-v']],
    ['Chromium', config.pipeline.chromiumBin, ['--version']],
    ['unzip', 'unzip', ['-v']],
  ];
  const results = {};
  for (const [name, bin, args] of checks) {
    try {
      const { stdout, stderr } = await run(bin, args, { timeout: 20000 });
      results[name] = { ok: true, version: String(stdout || stderr).split('\n')[0].trim() };
    } catch (e) {
      results[name] = { ok: false, error: e.message.split('\n')[0] };
    }
  }
  return results;
}

/**
 * Post-install check. Verifies the converters exist AND that a real
 * conversion completes end to end, because a `soffice --version` that
 * succeeds tells you nothing about whether the profile directory is
 * writable or the fonts are installed. Prints a report and exits nonzero
 * on failure so it can be used in a provisioning script.
 *
 *   node -e "require('./src/render').selfTest()"
 */
async function selfTest() {
  let bad = 0;
  console.log('Converters');
  const tools = await checkToolchain();
  for (const [name, r] of Object.entries(tools)) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${name.padEnd(12)} ${r.version || r.error}`);
    if (!r.ok) bad++;
  }

  console.log('\nRound trip');
  const work = await storage.tempDir('selftest');
  const doc = '<html><body style="font:48px Georgia">Poster Portal self test</body></html>';
  try {
    // The LibreOffice path is the one that matters — it carries the slide
    // decks. Converting a trivial HTML file through soffice proves the binary
    // runs, the throwaway profile directory is writable, and the fonts
    // resolve, none of which `soffice --version` tells you.
    const src = path.join(work, 't.html');
    await fsp.writeFile(src, doc);
    const pdf = await officeToPdf(src, work);
    const png = await pdfToPng(pdf, work, { widthPx: 1200, heightPx: 900, page: 1 });
    const md = await sharp(png).metadata();
    console.log(`  ok   LibreOffice -> PDF -> PNG   ${md.width}x${md.height}`);
  } catch (e) {
    console.log(`  FAIL LibreOffice -> PDF -> PNG   ${e.message.split('\n')[0]}`);
    console.log('       Slides and documents will not render. See README 3.1.');
    bad++;
  }

  // Chromium is only needed for HTML uploads, so a failure here is a
  // feature being unavailable rather than the install being broken.
  if (config.features.htmlUploads) {
    try {
      const src = path.join(work, 'c.html');
      await fsp.writeFile(src, doc);
      const pdf = await htmlToPdf(src, work, { finishedWidthIn: 12, finishedHeightIn: 9 });
      const png = await pdfToPng(pdf, work, { widthPx: 1200, heightPx: 900, page: 1 });
      const md = await sharp(png).metadata();
      console.log(`  ok   Chromium   -> PDF -> PNG   ${md.width}x${md.height}`);
    } catch (e) {
    // run() already appends the child's stderr to the message; print the
    // whole thing rather than the first line. The first line is always a
    // generic "Command failed", and the real cause — a snap-confined
    // Chromium unable to read DATA_ROOT, a missing shared library — is in
    // the stderr underneath it.
    console.log(`  WARN Chromium   -> PDF -> PNG`);
    console.log(String(e.message).split('\n').map((l) => '       ' + l).join('\n'));
    console.log('       HTML uploads only. Set FEATURE_HTML_UPLOADS=false to hide');
    console.log('       the option, or install a non-snap Chromium (README 3.1).');
  }
  }
  await storage.rmrf(work);

  console.log(bad ? `\n${bad} problem(s) found.` : '\nAll good.');
  if (require.main === module) process.exit(bad ? 1 : 0);
  return bad === 0;
}

module.exports = {
  buildPrintRaster, buildPreview, officeToPdf, htmlToPdf, pdfToPng,
  checkToolchain, selfTest,
};
