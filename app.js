
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function el(tag, props) {
    var e = document.createElement(tag);
    props = props || {};
    Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var kids = [].concat(arguments[i]);
      kids.forEach(function (kid) { if (kid != null) e.append(kid.nodeType ? kid : document.createTextNode(String(kid))); });
    }
    return e;
  }

  var libsOk = typeof PDFLib !== 'undefined';
  if (!libsOk) { var le = $('#lib-error'); if (le) le.hidden = false; }
  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  // ---------- helpers ----------
  var uid = 0;
  function fmt(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }
  function baseName(n) { return String(n).replace(/\.[^.]+$/, '').replace(/[\\\/:*?"<>|]+/g, '_').trim() || 'document'; }
  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }
  function radio(name) { var r = document.querySelector('input[name="' + name + '"]:checked'); return r ? r.value : null; }
  function friendly(e) {
    if (!e) return 'Something went wrong. Try again.';
    if (e.name === 'PasswordException') return 'This PDF is password-protected. Remove the password, then try again.';
    return e.message ? e.message : 'Something went wrong. Try again.';
  }
  function toBlob(canvas, type, q) { return new Promise(function (res, rej) { canvas.toBlob(function (b) { b ? res(b) : rej(new Error('Could not encode the image.')); }, type, q); }); }

  async function pdfPages(file) {
    var bytes = await file.arrayBuffer();
    try {
      var doc = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
      return doc.getPageCount();
    } catch (e) {
      throw new Error(/encrypt/i.test(String(e && e.message)) ? file.name + ' is password-protected. Remove the password, then try again.' : file.name + ' could not be read as a PDF.');
    }
  }

  // ---------- saving (downloads capability, with a plain-link fallback) ----------
  var capPromise = (window.claude && window.claude.use) ? window.claude.use('downloads').catch(function () { return null; }) : Promise.resolve(null);
  function fallbackDownload(blob, name) {
    var u = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = u; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(u); }, 5000);
  }
  async function saveBlob(blob, filename, statusEl) {
    statusEl.textContent = '';
    try {
      var cap = await capPromise;
      if (cap) {
        await cap.save({ filename: filename, data: blob });
        statusEl.textContent = 'Saved ' + filename + '.';
      } else {
        fallbackDownload(blob, filename);
        statusEl.textContent = "Download started. If nothing happens, check your browser's download settings.";
      }
    } catch (err) {
      var c = err && err.code;
      statusEl.textContent = c === 'declined' ? 'Save cancelled.'
        : c === 'too_large' ? 'That file is too large for this destination. Try a smaller quality setting.'
        : 'Could not save the file. ' + (err && err.message ? err.message : '');
    }
  }

  // ---------- state ----------
  var tools = {
    compress: { multi: false, kind: 'pdf', files: [], busy: false },
    merge: { multi: true, kind: 'pdf', files: [], busy: false },
    split: { multi: false, kind: 'pdf', files: [], busy: false },
    images: { multi: true, kind: 'img', files: [], busy: false }
  };
  function P(id) { return $('#p-' + id); }

  function release(item) { if (item.url) URL.revokeObjectURL(item.url); }

  async function addFiles(id, list) {
    var t = tools[id], p = P(id), msg = $('.msg', p);
    msg.textContent = '';
    var arr = Array.prototype.slice.call(list).filter(function (f) {
      return t.kind === 'pdf'
        ? (f.type === 'application/pdf' || /\.pdf$/i.test(f.name))
        : (f.type.indexOf('image/') === 0 || /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(f.name));
    });
    if (!arr.length) {
      msg.textContent = t.kind === 'pdf' ? 'Choose a PDF file.' : 'Choose image files (JPG, PNG, WebP or GIF).';
      return;
    }
    if (!t.multi) arr = arr.slice(0, 1);
    for (var i = 0; i < arr.length; i++) {
      var f = arr[i];
      var item = { id: ++uid, file: f, name: f.name, size: f.size };
      try {
        if (t.kind === 'pdf') item.pages = await pdfPages(f);
        else item.url = URL.createObjectURL(f);
      } catch (e) { msg.textContent = friendly(e); continue; }
      if (!t.multi) { t.files.forEach(release); t.files = [item]; }
      else t.files.push(item);
    }
    clearResult(id);
    renderFiles(id);
    afterChange(id);
  }

  function renderFiles(id) {
    var t = tools[id], ul = $('.files', P(id));
    ul.textContent = '';
    ul.hidden = !t.files.length;
    t.files.forEach(function (it, i) {
      var thumb = t.kind === 'pdf' ? el('span', { class: 'thumb pdf', text: 'PDF' }) : el('img', { class: 'thumb', src: it.url, alt: '' });
      var meta = el('div', { class: 'fmeta' },
        el('span', { class: 'mono', text: fmt(it.size) }),
        t.kind === 'pdf' ? el('span', { class: 'mono', text: it.pages + (it.pages === 1 ? ' page' : ' pages') }) : null);
      var acts = el('div', { class: 'fact' });
      if (t.multi) {
        acts.append(
          el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Move ' + it.name + ' up', text: '↑', disabled: i === 0, onclick: function () { move(id, i, -1); } }),
          el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Move ' + it.name + ' down', text: '↓', disabled: i === t.files.length - 1, onclick: function () { move(id, i, 1); } })
        );
      }
      acts.append(el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove ' + it.name, text: '×', onclick: function () { removeAt(id, i); } }));
      ul.append(el('li', { class: 'file' }, thumb, el('div', { style: 'min-width:0' }, el('div', { class: 'fname', title: it.name, text: it.name }), meta), acts));
    });
  }
  function move(id, i, d) {
    var a = tools[id].files, j = i + d;
    if (j < 0 || j >= a.length) return;
    var x = a[i]; a[i] = a[j]; a[j] = x;
    clearResult(id); renderFiles(id);
  }
  function removeAt(id, i) {
    var t = tools[id];
    release(t.files[i]);
    t.files.splice(i, 1);
    clearResult(id); renderFiles(id); afterChange(id);
  }

  function afterChange(id) {
    var t = tools[id];
    if (id === 'split') {
      var f = t.files[0];
      if (f) {
        $('#range').value = '1-' + Math.min(3, f.pages);
        $('#split-total').textContent = 'This file has ' + f.pages + (f.pages === 1 ? ' page.' : ' pages.') + ' Use commas and dashes, like 1-3, 5, 8-';
        $('#per').value = Math.max(1, Math.ceil(f.pages / 2));
      } else {
        $('#split-total').textContent = 'Use commas and dashes. An open range like 8- runs to the last page.';
      }
    }
    updateRun(id);
  }
  function updateRun(id) {
    var t = tools[id], btn = $('.run', P(id));
    var need = id === 'merge' ? 2 : 1;
    btn.disabled = t.busy || t.files.length < need;
    if (id === 'merge') {
      var h = $('.merge-hint');
      h.textContent = t.files.length >= 2 ? t.files.length + ' files ready.' : 'Add at least two files.';
    }
  }

  // ---------- busy / progress / results ----------
  function clearResult(id) { var r = $('.result', P(id)); r.hidden = true; r.textContent = ''; }
  async function withBusy(id, fn) {
    var t = tools[id], p = P(id);
    if (t.busy) return;
    t.busy = true; clearResult(id); $('.msg', p).textContent = '';
    var prog = $('.prog', p), bar = $('progress', prog), txt = $('.prog-text', prog);
    prog.hidden = false; bar.value = 0; txt.textContent = 'Starting';
    $('.run', p).disabled = true;
    var progress = function (v, s) { bar.value = v; txt.textContent = s; };
    try { await fn(progress); }
    catch (e) { console.error(e); $('.msg', p).textContent = friendly(e); }
    finally { t.busy = false; prog.hidden = true; updateRun(id); }
  }
  function showResult(id, o) {
    var r = $('.result', P(id));
    r.textContent = '';
    var status = el('span', { class: 'save-status', role: 'status' });
    r.append(el('div', { class: 'res-head' },
      el('span', { class: 'chip', text: o.chip || 'Checkmate' }),
      el('span', { class: 'res-name mono', text: o.filename + ' · ' + fmt(o.blob.size) })));
    if (o.line) r.append(el('p', { class: 'res-line' }, o.line));
    if (o.compare) {
      var b = o.compare.before, a = o.compare.after, mx = Math.max(a, b);
      r.append(el('div', { class: 'cmp', 'aria-hidden': 'true' },
        el('span', { text: 'Original' }), el('span', { class: 'track' }, el('span', { class: 'fill', style: 'display:block;width:' + (b / mx * 100) + '%' })), el('span', { class: 'val mono', text: fmt(b) }),
        el('span', { text: 'Result' }), el('span', { class: 'track' }, el('span', { class: 'fill new', style: 'display:block;width:' + (a / mx * 100) + '%' })), el('span', { class: 'val mono', text: fmt(a) })));
    }
    if (o.note) r.append(el('p', { class: 'note', text: o.note }));
    r.append(el('div', { class: 'actions' },
      el('button', { type: 'button', class: 'btn', text: 'Save ' + o.filename.split('.').pop().toUpperCase(), onclick: function () { saveBlob(o.blob, o.filename, status); } }),
      status));
    r.hidden = false;
    if (r.scrollIntoView) r.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ---------- compress ----------
  var PRESETS = { small: { scale: 1, q: 0.5 }, balanced: { scale: 1.4, q: 0.65 }, sharp: { scale: 2, q: 0.82 } };
  async function runCompress() {
    var f = tools.compress.files[0];
    if (!f) return;
    if (typeof pdfjsLib === 'undefined') { $('.msg', P('compress')).textContent = 'The PDF reader did not load. Reload the page and try again.'; return; }
    var pre = PRESETS[radio('cq')] || PRESETS.balanced;
    await withBusy('compress', async function (progress) {
      progress(0, 'Opening PDF');
      var bytes = new Uint8Array(await f.file.arrayBuffer());
      var src = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
      var out = await PDFLib.PDFDocument.create();
      for (var i = 1; i <= src.numPages; i++) {
        var page = await src.getPage(i);
        var base = page.getViewport({ scale: 1 });
        var vp = page.getViewport({ scale: pre.scale });
        var canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        var blob = await toBlob(canvas, 'image/jpeg', pre.q);
        var img = await out.embedJpg(await blob.arrayBuffer());
        var np = out.addPage([base.width, base.height]);
        np.drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
        page.cleanup(); canvas.width = 0; canvas.height = 0;
        progress(i / src.numPages, 'Page ' + i + ' of ' + src.numPages);
        await tick();
      }
      await src.destroy();
      var res = await out.save();
      var blobOut = new Blob([res], { type: 'application/pdf' });
      var diff = (1 - blobOut.size / f.size) * 100;
      var smaller = diff > 0.5;
      showResult('compress', {
        blob: blobOut,
        filename: baseName(f.name) + '-compressed.pdf',
        line: smaller
          ? [el('strong', { class: 'verdict-good', text: diff.toFixed(0) + '% smaller' }), ' · ' + src.numPages + (src.numPages === 1 ? ' page' : ' pages')]
          : [el('strong', { class: 'verdict-warn', text: 'No saving on this file' }), ' · the result is ' + Math.abs(diff).toFixed(0) + '% ' + (diff < 0 ? 'larger' : 'the same size')],
        compare: { before: f.size, after: blobOut.size },
        chip: smaller ? 'Checkmate' : 'Stalemate',
        note: smaller ? null : 'This PDF is already compact. Try the Smallest setting, or keep the original.'
      });
    });
  }

  // ---------- merge ----------
  async function runMerge() {
    var files = tools.merge.files;
    if (files.length < 2) return;
    await withBusy('merge', async function (progress) {
      var out = await PDFLib.PDFDocument.create();
      var total = 0;
      for (var i = 0; i < files.length; i++) {
        progress(i / files.length, 'Adding ' + files[i].name);
        var d = await PDFLib.PDFDocument.load(await files[i].file.arrayBuffer());
        var pages = await out.copyPages(d, d.getPageIndices());
        pages.forEach(function (pg) { out.addPage(pg); });
        total += pages.length;
        await tick();
      }
      progress(1, 'Saving');
      var res = await out.save();
      showResult('merge', {
        blob: new Blob([res], { type: 'application/pdf' }),
        filename: 'merged.pdf',
        line: [el('strong', { text: files.length + ' files' }), ' · ' + total + ' pages in total']
      });
    });
  }

  // ---------- split ----------
  function parseRanges(text, n) {
    var parts = text.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!parts.length) return { error: 'Enter the pages to keep, for example 1-3, 5.' };
    var idx = [];
    for (var i = 0; i < parts.length; i++) {
      var s = parts[i], m;
      var a, b;
      if ((m = /^(\d+)$/.exec(s))) { a = b = +m[1]; }
      else if ((m = /^(\d*)\s*-\s*(\d*)$/.exec(s)) && (m[1] || m[2])) { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : n; }
      else return { error: '"' + s + '" is not a page or range. Use numbers and dashes, like 2-4.' };
      if (a < 1 || b < 1 || a > n || b > n) return { error: 'Pages must be between 1 and ' + n + '. "' + s + '" is outside that.' };
      if (a > b) return { error: '"' + s + '" runs backwards. Write it as ' + b + '-' + a + '.' };
      for (var k = a; k <= b; k++) idx.push(k - 1);
    }
    return { idx: idx };
  }
  async function runSplit() {
    var f = tools.split.files[0];
    if (!f) return;
    var mode = radio('sm');
    var msg = $('.msg', P('split'));
    if (mode === 'extract') {
      var parsed = parseRanges($('#range').value, f.pages);
      if (parsed.error) { clearResult('split'); msg.textContent = parsed.error; return; }
      await withBusy('split', async function (progress) {
        progress(0.2, 'Reading PDF');
        var src = await PDFLib.PDFDocument.load(await f.file.arrayBuffer());
        var out = await PDFLib.PDFDocument.create();
        (await out.copyPages(src, parsed.idx)).forEach(function (pg) { out.addPage(pg); });
        progress(0.9, 'Saving');
        var res = await out.save();
        showResult('split', {
          blob: new Blob([res], { type: 'application/pdf' }),
          filename: baseName(f.name) + '-extract.pdf',
          line: [el('strong', { text: parsed.idx.length + (parsed.idx.length === 1 ? ' page' : ' pages') }), ' kept from ' + f.pages]
        });
      });
    } else {
      var per = parseInt($('#per').value, 10);
      if (!(per >= 1)) { clearResult('split'); msg.textContent = 'Enter how many pages each file should hold, starting at 1.'; return; }
      await withBusy('split', async function (progress) {
        var src = await PDFLib.PDFDocument.load(await f.file.arrayBuffer());
        var n = src.getPageCount();
        per = Math.min(per, n);
        var parts = Math.ceil(n / per);
        if (typeof JSZip === 'undefined') throw new Error('The ZIP library did not load. Reload the page and try again.');
        var zip = new JSZip();
        var b = baseName(f.name);
        for (var k = 0; k < parts; k++) {
          progress(k / parts, 'Part ' + (k + 1) + ' of ' + parts);
          var out = await PDFLib.PDFDocument.create();
          var idx = [];
          for (var i = k * per; i < Math.min(n, (k + 1) * per); i++) idx.push(i);
          (await out.copyPages(src, idx)).forEach(function (pg) { out.addPage(pg); });
          zip.file(b + '-part-' + String(k + 1).padStart(2, '0') + '.pdf', await out.save());
          await tick();
        }
        progress(1, 'Zipping');
        var blob = await zip.generateAsync({ type: 'blob' });
        showResult('split', {
          blob: blob,
          filename: b + '-parts.zip',
          line: [el('strong', { text: parts + (parts === 1 ? ' file' : ' files') }), ' · up to ' + per + (per === 1 ? ' page each' : ' pages each')]
        });
      });
    }
  }

  // ---------- images to PDF ----------
  var IMGQ = { high: { max: 2400, q: 0.9 }, medium: { max: 1600, q: 0.75 }, small: { max: 1100, q: 0.55 } };
  async function loadBitmap(file) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (_) { /* fall back to an img element */ }
    return await new Promise(function (res, rej) {
      var u = URL.createObjectURL(file), im = new Image();
      im.onload = function () { URL.revokeObjectURL(u); res(im); };
      im.onerror = function () { URL.revokeObjectURL(u); rej(new Error(file.name + ' could not be read as an image.')); };
      im.src = u;
    });
  }
  async function imageToJpeg(file, maxDim, q) {
    var src = await loadBitmap(file);
    var sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height;
    var k = Math.min(1, maxDim / Math.max(sw, sh));
    var w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var x = c.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, w, h);
    x.drawImage(src, 0, 0, w, h);
    if (src.close) src.close();
    var blob = await toBlob(c, 'image/jpeg', q);
    c.width = 0; c.height = 0;
    return { bytes: await blob.arrayBuffer(), w: w, h: h };
  }
  async function runImages() {
    var files = tools.images.files;
    if (!files.length) return;
    var q = IMGQ[radio('iq')] || IMGQ.medium;
    var ps = $('#ps').value;
    var m = $('#margin').checked ? 28.35 : 0; // 10 mm in points
    await withBusy('images', async function (progress) {
      var out = await PDFLib.PDFDocument.create();
      for (var i = 0; i < files.length; i++) {
        progress(i / files.length, 'Image ' + (i + 1) + ' of ' + files.length);
        var r = await imageToJpeg(files[i].file, q.max, q.q);
        var img = await out.embedJpg(r.bytes);
        var pw, ph;
        if (ps === 'fit') {
          var k = Math.min(1, 842 / Math.max(r.w, r.h));
          pw = r.w * k + 2 * m; ph = r.h * k + 2 * m;
        } else {
          var sz = ps === 'a4' ? [595.28, 841.89] : [612, 792];
          pw = sz[0]; ph = sz[1];
          if (r.w > r.h) { var t = pw; pw = ph; ph = t; }
        }
        var s = Math.min((pw - 2 * m) / r.w, (ph - 2 * m) / r.h);
        var dw = r.w * s, dh = r.h * s;
        var pg = out.addPage([pw, ph]);
        pg.drawImage(img, { x: (pw - dw) / 2, y: (ph - dh) / 2, width: dw, height: dh });
        await tick();
      }
      progress(1, 'Saving');
      var res = await out.save();
      showResult('images', {
        blob: new Blob([res], { type: 'application/pdf' }),
        filename: 'images.pdf',
        line: [el('strong', { text: files.length + (files.length === 1 ? ' page' : ' pages') }), ' · ' + (ps === 'fit' ? 'sized to each image' : ps === 'a4' ? 'A4' : 'Letter')]
      });
    });
  }

  // ---------- wiring ----------
  $$('.drop').forEach(function (z) {
    var id = z.getAttribute('data-drop');
    var input = $('input[type="file"]', z);
    input.addEventListener('change', function () { if (input.files && input.files.length) addFiles(id, input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) { z.addEventListener(ev, function (e) { e.preventDefault(); z.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { z.addEventListener(ev, function (e) { e.preventDefault(); z.classList.remove('over'); }); });
    z.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files.length) addFiles(id, e.dataTransfer.files); });
  });
  function on(sel, ev, fn) { var e = $(sel); if (e) e.addEventListener(ev, fn); }
  on('#p-compress .run', 'click', runCompress);
  on('#p-merge .run', 'click', runMerge);
  on('#p-split .run', 'click', runSplit);
  on('#p-images .run', 'click', runImages);
  $$('input[name="sm"]').forEach(function (r) {
    r.addEventListener('change', function () {
      var ex = radio('sm') === 'extract';
      $('#split-extract').hidden = !ex; $('#split-chunks').hidden = ex;
      $('.msg', P('split')).textContent = ''; clearResult('split');
    });
  });


})();
