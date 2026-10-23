'use strict';
/**
 * ============================================================================
 *  PREFLIGHT
 * ============================================================================
 *  Cheap checks only — metadata, never rasterisation. Runs in ~30 ms so the
 *  browser can show a verdict the instant the file lands.
 *
 *  Three corrections to the original poster_resize.js logic:
 *
 *  1. Embedded density is not evidence. sharp returns density 72 for a JPEG
 *     with no JFIF resolution unit, so `metadata.density || 300` silently
 *     yields 72 and every downstream number is wrong. Effective DPI is
 *     computed *only* as (pixels across a dimension) / (finished inches of
 *     that dimension). Declared density is reported for information.
 *
 *  2. The roll width constrains the SHORT side, not the width. A 48x36
 *     landscape poster on a 36" roll prints 36" across the roll and feeds out
 *     48". Mapping "target width" onto image width, as the old script did,
 *     produces a 36x27 poster and a confused customer.
 *
 *  3. A PDF has no pixels. Rasterising it at the target DPI gives target DPI
 *     by definition; the real risk is that the page is smaller than the
 *     finished size, which enlarges every embedded photo. That is reported
 *     separately as an enlargement factor.
 * ============================================================================
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const sharp = require('sharp');
const config = require('./config');

const execFileP = promisify(execFile);
const PT_PER_IN = 72;

const ACCEPTED = {
  'application/pdf': 'pdf',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/tiff': 'image',
  'image/webp': 'image',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'office',
  'application/vnd.ms-powerpoint': 'office',
  'application/vnd.oasis.opendocument.presentation': 'office',
  'text/html': 'html',
};
const EXT_MIME = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.webp': 'image/webp', '.html': 'text/html', '.htm': 'text/html',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
};

function classify(mime, filename) {
  let m = (mime || '').toLowerCase().split(';')[0];
  if (!ACCEPTED[m]) m = EXT_MIME[path.extname(filename || '').toLowerCase()] || m;
  return { mime: m, kind: ACCEPTED[m] || null };
}

// ---------------------------------------------------------------------------
// Source inspection
// ---------------------------------------------------------------------------
async function inspectSource(absPath, mime, filename) {
  const { mime: m, kind } = classify(mime, filename);
  if (!kind) {
    const e = new Error(`Unsupported file type: ${mime || path.extname(filename || '')}`);
    e.code = 'UNSUPPORTED_TYPE';
    throw e;
  }

  if (kind === 'image') {
    const md = await sharp(absPath, { limitInputPixels: false }).metadata();
    // EXIF orientation 5-8 swap the visual axes.
    const swap = md.orientation && md.orientation >= 5;
    return {
      kind: 'image', mime: m, pages: 1,
      widthPx: swap ? md.height : md.width,
      heightPx: swap ? md.width : md.height,
      declaredDpi: md.density || null,
      hasAlpha: !!md.hasAlpha,
      colorSpace: md.space || null,
      isVector: false,
    };
  }

  if (kind === 'pdf') {
    const info = await pdfInfo(absPath);
    return {
      kind: 'pdf', mime: m, pages: info.pages,
      pointWidth: info.pointWidth, pointHeight: info.pointHeight,
      nativeWidthIn: info.pointWidth / PT_PER_IN,
      nativeHeightIn: info.pointHeight / PT_PER_IN,
      // Rasterised on our side, so "pixels" are whatever we choose.
      widthPx: null, heightPx: null, declaredDpi: null,
      isVector: true, pdfVersion: info.version,
    };
  }

  if (kind === 'office') {
    // Slide geometry lives in ppt/presentation.xml as EMU (914400 per inch).
    const slide = await pptxSlideSize(absPath).catch(() => null);
    return {
      kind: 'office', mime: m, pages: null,
      nativeWidthIn: slide ? slide.widthIn : null,
      nativeHeightIn: slide ? slide.heightIn : null,
      widthPx: null, heightPx: null, declaredDpi: null,
      isVector: true, needsConversion: true,
    };
  }

  return {
    kind: 'html', mime: m, pages: 1, isVector: true, needsConversion: true,
    widthPx: null, heightPx: null, nativeWidthIn: null, nativeHeightIn: null,
  };
}

async function pdfInfo(absPath) {
  const { stdout } = await execFileP(config.pipeline.pdfinfoBin, [absPath], {
    timeout: 15000, maxBuffer: 1 << 20,
  });
  const pages = Number((/^Pages:\s+(\d+)/m.exec(stdout) || [])[1] || 1);
  const size = /^Page size:\s+([\d.]+) x ([\d.]+) pts/m.exec(stdout);
  const rot = Number((/^Page rot:\s+(\d+)/m.exec(stdout) || [])[1] || 0);
  let w = size ? parseFloat(size[1]) : 0;
  let h = size ? parseFloat(size[2]) : 0;
  if (rot === 90 || rot === 270) [w, h] = [h, w];
  if (!w || !h) { const e = new Error('Could not read PDF page size'); e.code = 'BAD_PDF'; throw e; }
  return {
    pages, pointWidth: w, pointHeight: h,
    version: (/^PDF version:\s+(.+)$/m.exec(stdout) || [])[1] || null,
  };
}

const EMU_PER_IN = 914400;
async function pptxSlideSize(absPath) {
  // unzip -p is faster and lighter than pulling in a zip library for one string.
  const { stdout } = await execFileP('unzip', ['-p', absPath, 'ppt/presentation.xml'], {
    timeout: 15000, maxBuffer: 8 << 20,
  });
  const m = /sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(stdout);
  if (!m) return null;
  return { widthIn: +m[1] / EMU_PER_IN, heightIn: +m[2] / EMU_PER_IN };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------
/**
 * Work out the finished poster size on a given roll.
 * The short side of the artwork always runs across the roll.
 */
function computeLayout(src, { rollWidthIn, fitMode = 'fit_roll', printer = null }) {
  const printableIn = printer
    ? printer.printable_width_in
    : rollWidthIn - 2 * config.print.edgeMarginIn;
  const maxLenIn = printer ? printer.max_length_in : config.print.maxLengthIn;

  // Aspect ratio of the artwork, from whichever geometry we have.
  let aw, ah;
  if (src.widthPx && src.heightPx) { aw = src.widthPx; ah = src.heightPx; }
  else if (src.nativeWidthIn && src.nativeHeightIn) { aw = src.nativeWidthIn; ah = src.nativeHeightIn; }
  else { aw = 48; ah = 36; }                        // HTML with no hint: assume 4:3
  const ratio = aw / ah;
  const orientation = ratio >= 1 ? 'landscape' : 'portrait';

  let finishedW, finishedH;
  if (fitMode === 'actual_size' && src.nativeWidthIn && src.nativeHeightIn) {
    finishedW = src.nativeWidthIn;
    finishedH = src.nativeHeightIn;
  } else {
    // Scale so the short side lands on the printable roll width.
    const shortIsHeight = ratio >= 1;
    if (shortIsHeight) { finishedH = printableIn; finishedW = printableIn * ratio; }
    else { finishedW = printableIn; finishedH = printableIn / ratio; }
    // If that overruns the length limit, back off proportionally.
    const runLen = Math.max(finishedW, finishedH);
    if (runLen > maxLenIn) {
      const k = maxLenIn / runLen;
      finishedW *= k; finishedH *= k;
    }
  }

  const acrossRollIn = Math.min(finishedW, finishedH);
  const alongRollIn = Math.max(finishedW, finishedH);

  return {
    rollWidthIn, printableWidthIn: round2(printableIn), orientation,
    finishedWidthIn: round2(finishedW), finishedHeightIn: round2(finishedH),
    acrossRollIn: round2(acrossRollIn), printLengthIn: round2(alongRollIn),
    aspectRatio: round3(Math.max(ratio, 1 / ratio)),
    areaSqFt: round2((finishedW * finishedH) / 144),
  };
}

/**
 * Pixel dimensions of the print-ready raster, and the resulting DPI.
 * Rotation is applied so the raster's short side is the roll axis, which is
 * what the driver expects on a custom page size.
 */
function computeRaster(src, layout, targetDpi = config.print.targetDpi) {
  const wPx = Math.round(layout.finishedWidthIn * targetDpi);
  const hPx = Math.round(layout.finishedHeightIn * targetDpi);

  let effectiveDpi = targetDpi;
  let enlargement = 1;

  if (src.widthPx && src.heightPx) {
    // Raster source: real resolution is fixed by the pixels we were given.
    effectiveDpi = Math.floor(
      Math.min(src.widthPx / layout.finishedWidthIn, src.heightPx / layout.finishedHeightIn)
    );
    enlargement = Math.max(wPx / src.widthPx, hPx / src.heightPx);
  } else if (src.nativeWidthIn && src.nativeHeightIn) {
    // Vector source: DPI is whatever we render at; risk is enlarging embedded photos.
    enlargement = layout.finishedWidthIn / src.nativeWidthIn;
    effectiveDpi = targetDpi;
  }

  return {
    targetDpi,
    widthPx: wPx, heightPx: hPx,
    megapixels: round2((wPx * hPx) / 1e6),
    effectiveDpi,
    enlargement: round2(enlargement),
    estimatedPrintBytes: Math.round(wPx * hPx * 0.9), // ~0.9 B/px for a typical PNG poster
  };
}

const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;

/** Default page sizes people never change. Inches, width x height. */
const SLIDE_PRESETS = [
  [13.333, 7.5, 'PowerPoint 16:9 widescreen'],
  [10, 7.5, 'PowerPoint 4:3'],
  [11, 8.5, 'US Letter landscape'],
  [8.5, 11, 'US Letter portrait'],
  [11.69, 8.27, 'A4 landscape'],
  [8.27, 11.69, 'A4 portrait'],
  [10, 5.63, 'Google Slides 16:9'],
];
function matchSlidePreset(src) {
  if (!src.nativeWidthIn || !src.nativeHeightIn) return null;
  for (const [w, h, name] of SLIDE_PRESETS) {
    if (Math.abs(src.nativeWidthIn - w) < 0.2 && Math.abs(src.nativeHeightIn - h) < 0.2) {
      return name;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------
const SEVERITY_ORDER = { pass: 0, warn: 1, fail: 2 };

async function preflight(absPath, {
  mime, filename, rollWidthIn, fitMode = 'fit_roll', printer = null, byteSize = 0,
}) {
  const issues = [];
  const add = (severity, code, message, fix = null) =>
    issues.push({ severity, code, message, fix });

  let src;
  try {
    src = await inspectSource(absPath, mime, filename);
  } catch (err) {
    return {
      severity: 'fail', ok: false, source: null, layout: null, raster: null,
      issues: [{
        severity: 'fail', code: err.code || 'INSPECT_FAILED',
        message: err.code === 'UNSUPPORTED_TYPE'
          ? 'That file type can\'t be printed. Upload a PDF, PowerPoint, PNG, JPEG or HTML file.'
          : 'The file couldn\'t be read. It may be damaged or password protected.',
        fix: 'Re-export the file and try again.',
      }],
      checkedAt: new Date().toISOString(),
    };
  }

  const layout = computeLayout(src, { rollWidthIn, fitMode, printer });
  const targetDpi = printer ? printer.target_dpi : config.print.targetDpi;
  const raster = computeRaster(src, layout, targetDpi);

  // --- resolution -------------------------------------------------------
  if (src.widthPx) {
    if (raster.effectiveDpi < config.print.minDpi) {
      add('fail', 'DPI_TOO_LOW',
        `At ${layout.finishedWidthIn}" x ${layout.finishedHeightIn}" this file works out to ` +
        `${raster.effectiveDpi} DPI. The minimum we'll print is ${config.print.minDpi}.`,
        `Export at ${Math.ceil(layout.finishedWidthIn * config.print.minDpi)} px wide or larger, ` +
        `or print it smaller.`);
    } else if (raster.effectiveDpi < config.print.warnDpi) {
      add('warn', 'DPI_LOW',
        `${raster.effectiveDpi} DPI at full size. It will print, but fine text and photo ` +
        `detail will look soft up close.`,
        `For crisp results export at ${Math.ceil(layout.finishedWidthIn * targetDpi)} px wide.`);
    }
  } else if (raster.enlargement > 1.5) {
    add('warn', 'VECTOR_ENLARGED',
      `Your page is ${round2(src.nativeWidthIn)}" x ${round2(src.nativeHeightIn)}" and will be ` +
      `enlarged ${raster.enlargement}x to fill the roll. Text and shapes stay sharp; ` +
      `any photos you placed get ${raster.enlargement}x softer.`,
      'Rebuild the slide at the finished poster size for the sharpest result.');
  }

  // --- geometry ---------------------------------------------------------
  if (layout.aspectRatio > config.print.maxAspect) {
    add('fail', 'ASPECT_EXTREME',
      `This is a ${layout.aspectRatio}:1 shape — ${layout.finishedWidthIn}" x ` +
      `${layout.finishedHeightIn}". That's outside what these printers handle well.`,
      'Check the page setup in your source file; a slide left at 16:9 screen size is the usual cause.');
  }
  if (layout.printLengthIn > (printer ? printer.max_length_in : config.print.maxLengthIn)) {
    add('fail', 'TOO_LONG',
      `The finished print would be ${layout.printLengthIn}" long, past the ` +
      `${printer ? printer.max_length_in : config.print.maxLengthIn}" limit.`,
      'Reduce the poster size or split it across two sheets.');
  }
  if (layout.printLengthIn < config.print.minLengthIn) {
    add('warn', 'VERY_SHORT',
      `Only ${layout.printLengthIn}" long. A roll printer is an expensive way to make ` +
      `something this small.`,
      'An office plotter or a large-format copy shop may be a better fit.');
  }
  if (fitMode === 'actual_size' && layout.acrossRollIn > layout.printableWidthIn + 0.01) {
    add('fail', 'WIDER_THAN_ROLL',
      `At actual size the short side is ${layout.acrossRollIn}", wider than the ` +
      `${layout.printableWidthIn}" printable area of a ${rollWidthIn}" roll.`,
      `Choose a wider roll or switch to "fit to roll".`);
  }

  // --- the PowerPoint problem -------------------------------------------
  // Roughly nine in ten submissions are slides. The single most common fault
  // is a deck left at its default screen size: the content is fine, but it
  // scales to a 63" strip instead of the 48x36 the author pictured. Naming
  // the cause is worth more than any DPI number.
  const preset = matchSlidePreset(src);
  if (preset && fitMode === 'fit_roll') {
    add('warn', 'SLIDE_DEFAULT_SIZE',
      `This looks like a ${preset} slide that was never resized for print. ` +
      `Filling the ${rollWidthIn}" roll makes it ${layout.finishedWidthIn}" x ` +
      `${layout.finishedHeightIn}" — ${layout.printLengthIn}" of paper.`,
      'In PowerPoint: Design > Slide Size > Custom, set it to your finished ' +
      'poster size (48 x 36 is standard), then re-export.');
  }

  // --- multi-page -------------------------------------------------------
  if (src.pages > 1) {
    add('warn', 'MULTIPAGE',
      `This PDF has ${src.pages} pages. Only page 1 gets printed.`,
      'Export just the poster page.');
  }

  // --- practical limits -------------------------------------------------
  if (raster.megapixels > config.print.maxPrintMegapixels) {
    add('fail', 'RASTER_TOO_BIG',
      `The print file would be ${raster.megapixels} megapixels, past our ` +
      `${config.print.maxPrintMegapixels} MP ceiling.`,
      'Print at a smaller finished size.');
  }
  if (src.kind === 'image' && src.hasAlpha) {
    add('warn', 'HAS_TRANSPARENCY',
      'Transparent areas will print as white paper, not as "no ink".',
      'Flatten onto a white background before exporting if that matters.');
  }
  if (src.colorSpace === 'cmyk') {
    add('warn', 'CMYK_SOURCE',
      'CMYK artwork gets converted to the printer\'s own colour space. Expect a small shift ' +
      'in saturated colours.', null);
  }
  if (byteSize > config.print.maxUploadBytes) {
    add('fail', 'FILE_TOO_LARGE',
      `${Math.round(byteSize / 1048576)} MB is over the ` +
      `${Math.round(config.print.maxUploadBytes / 1048576)} MB limit.`, null);
  }

  const severity = issues.reduce(
    (acc, i) => (SEVERITY_ORDER[i.severity] > SEVERITY_ORDER[acc] ? i.severity : acc), 'pass');

  return {
    severity, ok: severity !== 'fail',
    source: src, layout, raster, issues,
    checkedAt: new Date().toISOString(),
  };
}

module.exports = {
  preflight, inspectSource, computeLayout, computeRaster, classify,
  pdfInfo, ACCEPTED, EXT_MIME,
};
