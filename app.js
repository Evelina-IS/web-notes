const STORAGE_KEY = 'web-notes:data';
const SETTINGS_KEY = 'web-notes:github';

const $ = (id) => document.getElementById(id);

let state = loadState();
let settings = loadSettings();
let activeId = state.activeId || state.notes[0]?.id;
let saveTimer = null;
let penSize = 4;
let penColor = '#111827';
let drawTool = 'pen';
let drawing = false;
let lastPoint = null;
let canvasApi = null;
let canvasMode = 'handwrite';
let editingImageId = null;
let canvasZoom = 1;
let canvasPanX = 0;
let canvasPanY = 0;
let touchStartDistance = 0;
let touchStartZoom = 1;
let touchStartCenter = null;
let touchStartPanX = 0;
let touchStartPanY = 0;
let touchPanStart = null;
let activeCanvasTouches = new Map();
let autoPushTimer = null;
let syncInFlight = false;
let pendingAutoPush = false;
let suppressAutoPush = false;

function now() {
  return new Date().toISOString();
}

function newNote(title = 'Untitled') {
  return {
    id: crypto.randomUUID(),
    title,
    body: '# Untitled\n\n',
    attachments: [],
    activeAttachmentId: null,
    pdfLinks: [],
    images: [],
    createdAt: now(),
    updatedAt: now(),
  };
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.notes)) return parsed;
    } catch {}
  }
  const first = newNote('Welcome');
  first.body = [
    '# Welcome',
    '',
    '写 Markdown，右边实时预览。',
    '',
    '```python',
    'print("hello notes")',
    '```',
  ].join('\n');
  return { version: 1, notes: [first], activeId: first.id, updatedAt: now() };
}

function loadSettings() {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (!raw) return { owner: '', repo: '', path: 'notes.json', token: '', autoSync: true };
  try {
    return { path: 'notes.json', autoSync: true, ...JSON.parse(raw) };
  } catch {
    return { owner: '', repo: '', path: 'notes.json', token: '', autoSync: true };
  }
}

function persist() {
  state.activeId = activeId;
  state.updatedAt = now();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  renderList();
  updateSyncState('Local saved');
  scheduleAutoPush();
}

function queuePersist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 250);
}

function activeNote() {
  return state.notes.find((note) => note.id === activeId) || state.notes[0];
}

function normalizeNote(note) {
  if (!Array.isArray(note.attachments)) note.attachments = [];
  if (!('activeAttachmentId' in note)) note.activeAttachmentId = note.attachments[0]?.id || null;
  if (!Array.isArray(note.pdfLinks)) note.pdfLinks = [];
  if (!Array.isArray(note.images)) note.images = [];
  return note;
}

function activeAttachment(note = activeNote()) {
  normalizeNote(note);
  return note.attachments.find((item) => item.id === note.activeAttachmentId) || note.attachments[0] || null;
}

function renderList() {
  const query = $('searchInput').value.trim().toLowerCase();
  const list = $('noteList');
  list.innerHTML = '';
  const notes = [...state.notes]
    .filter((note) => !query || `${note.title}\n${note.body}`.toLowerCase().includes(query))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  for (const note of notes) {
    const btn = document.createElement('button');
    btn.className = `note-item ${note.id === activeId ? 'active' : ''}`;
    btn.innerHTML = `<strong>${escapeHtml(note.title || 'Untitled')}</strong><span>${formatDate(note.updatedAt)}</span>`;
    btn.addEventListener('click', () => {
      activeId = note.id;
      render();
      persist();
    });
    list.appendChild(btn);
  }
}

function render() {
  const note = normalizeNote(activeNote());
  if (!note) return;
  $('titleInput').value = note.title;
  $('editor').value = note.body;
  updatePreview();
  renderOutline();
  renderPdfLinks();
  renderAttachments();
  renderPdfViewer();
  renderList();
}

function extractHeadings(markdown) {
  return markdown
    .split('\n')
    .map((line, index) => {
      const match = /^(#{1,3})\s+(.+)$/.exec(line.trim());
      if (!match) return null;
      return {
        level: match[1].length,
        text: match[2].replace(/[*_`]/g, '').trim(),
        line: index,
      };
    })
    .filter(Boolean);
}

function renderOutline() {
  const note = normalizeNote(activeNote());
  const list = $('outlineList');
  list.innerHTML = '';
  const headings = extractHeadings(note.body);
  if (!headings.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-panel';
    empty.textContent = '用 # / ## / ### 写标题后会自动生成大纲';
    list.appendChild(empty);
    return;
  }
  for (const heading of headings) {
    const btn = document.createElement('button');
    btn.className = `outline-level-${heading.level}`;
    btn.textContent = heading.text;
    btn.addEventListener('click', () => jumpToLine(heading.line));
    list.appendChild(btn);
  }
}

function renderPdfLinks() {
  const note = normalizeNote(activeNote());
  const list = $('pdfLinkList');
  list.innerHTML = '';
  const refs = extractPdfRefs(note.body);
  if (!refs.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-panel';
    empty.textContent = '在正文写 [[pdf:12|第 12 页]] 会生成页码按钮';
    list.appendChild(empty);
    return;
  }
  for (const link of refs) {
    const btn = document.createElement('button');
    btn.textContent = `${link.label} · p.${link.page}`;
    btn.title = `打开第 ${link.page} 页`;
    btn.addEventListener('click', () => openPdfPage(link.page));
    list.appendChild(btn);
  }
}

function jumpToLine(lineNumber) {
  const editor = $('editor');
  const lines = editor.value.split('\n');
  const position = lines.slice(0, lineNumber).reduce((sum, line) => sum + line.length + 1, 0);
  editor.focus();
  editor.selectionStart = position;
  editor.selectionEnd = position;
  const lineHeight = 24;
  editor.scrollTop = Math.max(0, lineNumber * lineHeight - editor.clientHeight * 0.25);
}

function renderAttachments() {
  const note = normalizeNote(activeNote());
  const list = $('attachmentList');
  list.innerHTML = '';
  if (!note.attachments.length) {
    const empty = document.createElement('span');
    empty.className = 'attachment-empty';
    empty.textContent = '还没有上传 PDF';
    list.appendChild(empty);
    return;
  }
  for (const item of note.attachments) {
    const btn = document.createElement('button');
    btn.className = `attachment-item ${item.id === note.activeAttachmentId ? 'active' : ''}`;
    btn.title = item.name;
    btn.textContent = item.name;
    btn.addEventListener('click', () => {
      note.activeAttachmentId = item.id;
      note.updatedAt = now();
      persist();
      renderAttachments();
      renderPdfViewer();
    });
    list.appendChild(btn);
  }
}

function pdfSource(item, page = null) {
  if (!item) return '';
  const pagePart = page ? `#page=${page}` : '';
  return `${item.dataUrl}${pagePart}`;
}

function renderPdfViewer(page = null) {
  const note = normalizeNote(activeNote());
  const item = activeAttachment(note);
  const viewer = $('pdfViewer');
  viewer.innerHTML = '';
  if (!item) {
    $('pdfMeta').textContent = '当前笔记无 PDF';
    $('openPdfBtn').disabled = true;
    const empty = document.createElement('p');
    empty.textContent = '上传 PDF 后会在这里预览。';
    viewer.appendChild(empty);
    return;
  }
  $('pdfMeta').textContent = `${item.name} · ${formatBytes(item.size || 0)}`;
  $('openPdfBtn').disabled = false;
  const object = document.createElement('object');
  object.type = 'application/pdf';
  object.data = pdfSource(item, page);
  object.innerHTML = `<iframe title="${escapeHtml(item.name)}" src="${pdfSource(item, page)}"></iframe>`;
  viewer.appendChild(object);
}

function openPdfPage(page, attachmentId = null) {
  const note = normalizeNote(activeNote());
  if (attachmentId) {
    note.activeAttachmentId = attachmentId;
  }
  renderAttachments();
  renderPdfViewer(page);
}

function formatDate(value) {
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatBytes(bytes) {
  if (!bytes) return 'unknown size';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderMarkdown(markdown) {
  const note = normalizeNote(activeNote());
  const codeBlocks = [];
  let text = markdown.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const token = `@@CODE_${codeBlocks.length}@@`;
    codeBlocks.push(`<pre><code data-lang="${escapeHtml(lang)}">${escapeHtml(code)}</code></pre>`);
    return token;
  });

  text = escapeHtml(text);
  text = text
    .replace(/\[\[pdf:(\d+)(?:\|([^\]]+))?\]\]/g, (_, page, label) => {
      const text = label || `第 ${page} 页`;
      return `<button class="pdf-ref" data-page="${page}" type="button">${text}</button>`;
    })
    .replace(/[!！]\[([^\]]*)\]\((data:image\/[^)]+)\)/g, '<img alt="$1" src="$2">')
    .replace(/\[([^\]]+)\]\((data:image\/[^)]+)\)/g, '<figure class="note-image"><img alt="$1" src="$2"><figcaption>$1</figcaption></figure>')
    .replace(/\[PDF:([^\]]+)\]\((data:application\/pdf[^)]+)\)/g, '<iframe title="$1" src="$2"></iframe>')
    .replace(/\[\[image:([A-Za-z0-9-]+)(?:\|([^\]]+))?\]\]/g, (_, id, label) => {
      const image = note.images.find((item) => item.id === id);
      if (!image) return `<span class="missing-embed">图片不存在：${id}</span>`;
      const caption = escapeHtml(label || image.name || '手写');
      return `<figure class="note-image" data-image-id="${id}"><button class="edit-image-btn" type="button" data-edit-image="${id}">编辑</button><img alt="${caption}" src="${image.dataUrl}"><figcaption>${caption}</figcaption></figure>`;
    })
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

  const renderInline = (value) => value
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  const blocks = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^- /.test(line)) {
      const items = [];
      while (index < lines.length && /^- /.test(lines[index])) {
        items.push(`<li>${renderInline(lines[index].slice(2))}</li>`);
        index += 1;
      }
      blocks.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    if (/^> /.test(line)) {
      const quotes = [];
      while (index < lines.length && /^> /.test(lines[index])) {
        quotes.push(renderInline(lines[index].slice(2)));
        index += 1;
      }
      blocks.push(`<blockquote>${quotes.join('<br>')}</blockquote>`);
      continue;
    }

    if (/^@@CODE_\d+@@$/.test(line) || /^\s*<(pre|img|iframe)/.test(line)) {
      blocks.push(line);
      index += 1;
      continue;
    }

    const paragraph = [];
    while (
      index < lines.length
      && lines[index].trim()
      && !/^(#{1,3})\s+/.test(lines[index])
      && !/^- /.test(lines[index])
      && !/^> /.test(lines[index])
      && !/^@@CODE_\d+@@$/.test(lines[index])
      && !/^\s*<(pre|img|iframe)/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(`<p>${renderInline(paragraph.join('<br>'))}</p>`);
  }

  text = blocks.join('\n');

  codeBlocks.forEach((html, index) => {
    text = text.replace(`@@CODE_${index}@@`, html);
  });
  return text;
}

function extractPdfRefs(markdown) {
  const refs = [];
  const regex = /\[\[pdf:(\d+)(?:\|([^\]]+))?\]\]/g;
  let match;
  while ((match = regex.exec(markdown))) {
    refs.push({
      page: Number.parseInt(match[1], 10),
      label: match[2] || `第 ${match[1]} 页`,
    });
  }
  return refs;
}

function bindPreviewActions() {
  $('preview').querySelectorAll('.pdf-ref').forEach((button) => {
    button.addEventListener('click', () => {
      const page = Number.parseInt(button.dataset.page, 10);
      if (Number.isFinite(page)) openPdfPage(page);
    });
  });
  $('preview').querySelectorAll('[data-edit-image]').forEach((button) => {
    button.addEventListener('click', () => {
      const note = normalizeNote(activeNote());
      const image = note.images.find((item) => item.id === button.dataset.editImage);
      if (image) drawImageOnCanvas(image.dataUrl, image.id);
    });
  });
}

function updatePreview() {
  $('preview').innerHTML = renderMarkdown(activeNote().body);
  bindPreviewActions();
}

function insertAtCursor(before, after = '') {
  const editor = $('editor');
  const note = activeNote();
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const selected = editor.value.slice(start, end);
  const next = editor.value.slice(0, start) + before + selected + after + editor.value.slice(end);
  note.body = next;
  note.updatedAt = now();
  editor.value = next;
  editor.focus();
  editor.selectionStart = start + before.length;
  editor.selectionEnd = start + before.length + selected.length;
  updatePreview();
  renderPdfLinks();
  queuePersist();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function setupCanvas() {
  const stage = $('canvasStage');
  const canvas = $('drawCanvas');
  const ctx = canvas.getContext('2d');

  function applyCanvasView() {
    canvas.style.transform = `translate(${canvasPanX}px, ${canvasPanY}px) scale(${canvasZoom})`;
    $('zoomResetBtn').textContent = `${Math.round(canvasZoom * 100)}%`;
  }

  function setCanvasZoom(nextZoom, origin = null) {
    const previous = canvasZoom;
    canvasZoom = Math.max(0.5, Math.min(4, nextZoom));
    if (origin && previous !== canvasZoom) {
      canvasPanX = origin.x - ((origin.x - canvasPanX) * canvasZoom) / previous;
      canvasPanY = origin.y - ((origin.y - canvasPanY) * canvasZoom) / previous;
    }
    applyCanvasView();
  }

  function resetCanvasView() {
    canvasZoom = 1;
    canvasPanX = 0;
    canvasPanY = 0;
    activeCanvasTouches.clear();
    touchStartDistance = 0;
    touchStartCenter = null;
    touchPanStart = null;
    applyCanvasView();
  }

  function resizeCanvas() {
    const rect = stage.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    const old = document.createElement('canvas');
    old.width = canvas.width;
    old.height = canvas.height;
    if (canvas.width && canvas.height) {
      old.getContext('2d').drawImage(canvas, 0, 0);
    }
    canvas.width = Math.max(1, Math.floor(rect.width * scale));
    canvas.height = Math.max(1, Math.floor(rect.height * scale));
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = penColor;
    if (old.width && old.height) {
      ctx.drawImage(old, 0, 0, rect.width, rect.height);
    }
  }

  function getPoint(event) {
    const rect = stage.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left - canvasPanX) / canvasZoom,
      y: (event.clientY - rect.top - canvasPanY) / canvasZoom,
      pressure: event.pressure || 0.5,
    };
  }

  function isPenEvent(event) {
    return event.pointerType === 'pen';
  }

  function stagePoint(event) {
    const rect = stage.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function midpoint(a, b) {
    return {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
    };
  }

  function start(event) {
    event.preventDefault();
    stage.setPointerCapture(event.pointerId);
    if (!isPenEvent(event)) {
      const point = stagePoint(event);
      activeCanvasTouches.set(event.pointerId, point);
      if (activeCanvasTouches.size === 1) {
        touchPanStart = {
          pointerId: event.pointerId,
          x: point.x,
          y: point.y,
          panX: canvasPanX,
          panY: canvasPanY,
        };
      } else if (activeCanvasTouches.size === 2) {
        const points = [...activeCanvasTouches.values()];
        touchStartDistance = distance(points[0], points[1]);
        touchStartCenter = midpoint(points[0], points[1]);
        touchStartZoom = canvasZoom;
        touchStartPanX = canvasPanX;
        touchStartPanY = canvasPanY;
      }
      return;
    }
    drawing = true;
    lastPoint = getPoint(event);
  }

  function move(event) {
    if (!isPenEvent(event)) {
      if (!activeCanvasTouches.has(event.pointerId)) return;
      event.preventDefault();
      activeCanvasTouches.set(event.pointerId, stagePoint(event));
      if (activeCanvasTouches.size === 2) {
        const points = [...activeCanvasTouches.values()];
        const nextDistance = distance(points[0], points[1]);
        const center = midpoint(points[0], points[1]);
        if (touchStartDistance > 0 && touchStartCenter) {
          canvasPanX = touchStartPanX + center.x - touchStartCenter.x;
          canvasPanY = touchStartPanY + center.y - touchStartCenter.y;
          setCanvasZoom(touchStartZoom * (nextDistance / touchStartDistance), center);
        }
      } else if (activeCanvasTouches.size === 1 && touchPanStart) {
        const point = activeCanvasTouches.get(event.pointerId);
        canvasPanX = touchPanStart.panX + point.x - touchPanStart.x;
        canvasPanY = touchPanStart.panY + point.y - touchPanStart.y;
        applyCanvasView();
      }
      return;
    }
    if (!drawing || !lastPoint) return;
    event.preventDefault();
    const next = getPoint(event);
    ctx.globalCompositeOperation = drawTool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = penColor;
    ctx.lineWidth = drawTool === 'eraser'
      ? 34
      : Math.max(1, penSize * (next.pressure || 0.5));
    ctx.beginPath();
    ctx.moveTo(lastPoint.x, lastPoint.y);
    ctx.lineTo(next.x, next.y);
    ctx.stroke();
    lastPoint = next;
  }

  function end(event) {
    event.preventDefault();
    if (!isPenEvent(event)) {
      activeCanvasTouches.delete(event.pointerId);
      if (activeCanvasTouches.size === 1) {
        const [pointerId, point] = [...activeCanvasTouches.entries()][0];
        touchPanStart = {
          pointerId,
          x: point.x,
          y: point.y,
          panX: canvasPanX,
          panY: canvasPanY,
        };
      } else {
        touchPanStart = null;
        touchStartDistance = 0;
        touchStartCenter = null;
      }
      return;
    }
    drawing = false;
    lastPoint = null;
  }

  stage.addEventListener('pointerdown', start);
  stage.addEventListener('pointermove', move);
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('wheel', (event) => {
    event.preventDefault();
    const origin = stagePoint(event);
    const factor = event.deltaY < 0 ? 1.12 : 0.88;
    setCanvasZoom(canvasZoom * factor, origin);
  }, { passive: false });
  window.addEventListener('resize', () => {
    if ($('handwriteDialog').open) resizeCanvas();
  });

  applyCanvasView();
  return { canvas, ctx, resizeCanvas, setCanvasZoom, resetCanvasView };
}

function updateToolButtons() {
  ['penBlackBtn', 'penRedBtn', 'penBlueBtn', 'eraserBtn'].forEach((id) => $(id).classList.remove('active'));
  if (drawTool === 'eraser') {
    $('eraserBtn').classList.add('active');
  } else if (penColor === '#c2410c') {
    $('penRedBtn').classList.add('active');
  } else if (penColor === '#1d4ed8') {
    $('penBlueBtn').classList.add('active');
  } else {
    $('penBlackBtn').classList.add('active');
  }
}

function setPen(color) {
  penColor = color;
  drawTool = 'pen';
  updateToolButtons();
}

function setEraser() {
  drawTool = 'eraser';
  updateToolButtons();
}

function clearCanvasToWhite() {
  if (!canvasApi) return;
  const { canvas, ctx } = canvasApi;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
}

function openCanvas(mode = 'handwrite', imageId = null) {
  canvasMode = mode;
  editingImageId = imageId;
  $('canvasTitle').textContent = imageId ? '编辑图片' : (mode === 'image' ? '编辑照片' : '手写笔记');
  $('handwriteDialog').showModal();
  if (!canvasApi) canvasApi = setupCanvas();
  requestAnimationFrame(() => {
    canvasApi.resetCanvasView();
    canvasApi.resizeCanvas();
    clearCanvasToWhite();
    updateToolButtons();
  });
}

function drawImageOnCanvas(dataUrl, imageId = null) {
  openCanvas('image', imageId);
  const image = new Image();
  image.onload = () => {
    const { canvas, ctx } = canvasApi;
    const rect = $('canvasStage').getBoundingClientRect();
    clearCanvasToWhite();
    const scale = Math.min(rect.width / image.width, rect.height / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    const x = (rect.width - width) / 2;
    const y = (rect.height - height) / 2;
    ctx.drawImage(image, x, y, width, height);
  };
  image.src = dataUrl;
}

function bindResizer(id, cssVar, min, max, side) {
  const handle = $(id);
  if (!handle) return;
  let startX = 0;
  let startValue = 0;

  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    startX = event.clientX;
    startValue = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(cssVar)) || min;
    document.body.classList.add('resizing');
    handle.setPointerCapture(event.pointerId);
  });

  handle.addEventListener('pointermove', (event) => {
    if (!document.body.classList.contains('resizing')) return;
    const delta = side === 'right' ? startX - event.clientX : event.clientX - startX;
    const next = Math.max(min, Math.min(max, startValue + delta));
    document.documentElement.style.setProperty(cssVar, `${next}px`);
  });

  function stop() {
    document.body.classList.remove('resizing');
  }

  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
}

function updateSyncState(text) {
  $('syncState').textContent = text;
}

function hasGithubSettings() {
  return Boolean(settings.owner && settings.repo && settings.path && settings.token);
}

function shouldAutoSync() {
  return settings.autoSync !== false && hasGithubSettings();
}

function scheduleAutoPush() {
  if (suppressAutoPush || !shouldAutoSync()) return;
  clearTimeout(autoPushTimer);
  autoPushTimer = setTimeout(() => {
    pushToGithub({ silent: true });
  }, 2000);
}

function githubUrl() {
  const path = encodeURIComponent(settings.path || 'notes.json').replaceAll('%2F', '/');
  return `https://api.github.com/repos/${settings.owner}/${settings.repo}/contents/${path}`;
}

function requireSettings() {
  if (!hasGithubSettings()) {
    $('settingsDialog').showModal();
    throw new Error('GitHub settings missing');
  }
}

function encodeBase64Unicode(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => binary += String.fromCharCode(byte));
  return btoa(binary);
}

function decodeBase64Unicode(value) {
  const binary = atob(value.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function githubErrorMessage(res) {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text);
    return parsed.message || text;
  } catch {
    return text || `${res.status} ${res.statusText}`;
  }
}

async function githubGet() {
  requireSettings();
  const res = await fetch(githubUrl(), {
    headers: {
      Authorization: `Bearer ${settings.token}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await githubErrorMessage(res));
  return res.json();
}

async function pullFromGithub(options = {}) {
  const { silent = false } = options;
  if (silent && !hasGithubSettings()) return false;
  if (syncInFlight) return false;
  syncInFlight = true;
  if (!silent) updateSyncState('Pulling...');
  try {
    const file = await githubGet();
    if (!file) {
      updateSyncState('Remote empty');
      return false;
    }
    const remote = JSON.parse(decodeBase64Unicode(file.content));
    if (!Array.isArray(remote.notes)) throw new Error('Invalid notes file');
    state = remote;
    activeId = state.activeId || state.notes[0]?.id;
    suppressAutoPush = true;
    persist();
    suppressAutoPush = false;
    render();
    updateSyncState('Pulled');
    return true;
  } catch (err) {
    updateSyncState(silent ? 'Auto pull failed' : 'Pull failed');
    if (!silent) alert(err.message);
    return false;
  } finally {
    suppressAutoPush = false;
    syncInFlight = false;
  }
}

async function pushToGithub(options = {}) {
  const { silent = false } = options;
  if (silent && !hasGithubSettings()) return false;
  if (syncInFlight) {
    pendingAutoPush = true;
    return false;
  }
  syncInFlight = true;
  pendingAutoPush = false;
  if (!silent) updateSyncState('Pushing...');
  try {
    const current = await githubGet();
    const body = {
      message: `Update notes ${new Date().toISOString()}`,
      content: encodeBase64Unicode(JSON.stringify(state, null, 2)),
    };
    if (current?.sha) body.sha = current.sha;
    const res = await fetch(githubUrl(), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${settings.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await githubErrorMessage(res));
    updateSyncState('GitHub synced');
    return true;
  } catch (err) {
    updateSyncState(silent ? 'Auto push failed' : 'Push failed');
    if (!silent) alert(err.message);
    return false;
  } finally {
    syncInFlight = false;
    if (pendingAutoPush && shouldAutoSync()) {
      pendingAutoPush = false;
      scheduleAutoPush();
    }
  }
}

async function startAutoSync() {
  if (!shouldAutoSync()) return;
  if (syncInFlight) return;
  syncInFlight = true;
  updateSyncState('Auto sync...');
  try {
    const file = await githubGet();
    if (!file) {
      syncInFlight = false;
      await pushToGithub({ silent: true });
      return;
    }
    const remote = JSON.parse(decodeBase64Unicode(file.content));
    if (!Array.isArray(remote.notes)) throw new Error('Invalid notes file');
    const remoteTime = Date.parse(remote.updatedAt || 0);
    const localTime = Date.parse(state.updatedAt || 0);
    if (remoteTime > localTime) {
      state = remote;
      activeId = state.activeId || state.notes[0]?.id;
      suppressAutoPush = true;
      persist();
      suppressAutoPush = false;
      render();
      updateSyncState('Auto pulled');
    } else if (localTime > remoteTime) {
      syncInFlight = false;
      await pushToGithub({ silent: true });
    } else {
      updateSyncState('GitHub synced');
    }
  } catch (err) {
    updateSyncState('Auto sync failed');
  } finally {
    suppressAutoPush = false;
    syncInFlight = false;
  }
}

function bindEvents() {
  $('newNoteBtn').addEventListener('click', () => {
    const note = newNote('Untitled');
    state.notes.unshift(note);
    activeId = note.id;
    persist();
    render();
  });

  $('searchInput').addEventListener('input', renderList);

  $('titleInput').addEventListener('input', (event) => {
    const note = activeNote();
    note.title = event.target.value || 'Untitled';
    note.updatedAt = now();
    queuePersist();
  });

  $('editor').addEventListener('input', (event) => {
    const note = activeNote();
    note.body = event.target.value;
    note.updatedAt = now();
    updatePreview();
    renderOutline();
    renderPdfLinks();
    queuePersist();
  });

  document.querySelectorAll('[data-wrap]').forEach((button) => {
    button.addEventListener('click', () => {
      const wrap = button.dataset.wrap;
      insertAtCursor(wrap, wrap);
    });
  });

  $('codeBtn').addEventListener('click', () => insertAtCursor('```python\n', '\n```'));
  $('imageBtn').addEventListener('click', () => $('imageInput').click());
  $('pdfBtn').addEventListener('click', () => $('pdfInput').click());
  $('handwriteBtn').addEventListener('click', () => {
    openCanvas('handwrite');
  });
  $('printBtn').addEventListener('click', () => {
    updatePreview();
    window.print();
  });

  $('imageInput').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const url = await fileToDataUrl(file);
    drawImageOnCanvas(url);
    event.target.value = '';
  });

  $('pdfInput').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      const ok = confirm('这个 PDF 超过 20 MB，同步到 GitHub 可能会比较慢甚至失败。仍然上传？');
      if (!ok) {
        event.target.value = '';
        return;
      }
    }
    const url = await fileToDataUrl(file);
    const note = normalizeNote(activeNote());
    const attachment = {
      id: crypto.randomUUID(),
      type: 'pdf',
      name: file.name,
      size: file.size,
      dataUrl: url,
      createdAt: now(),
    };
    note.attachments.push(attachment);
    note.activeAttachmentId = attachment.id;
    note.updatedAt = now();
    renderAttachments();
    renderPdfViewer();
    persist();
    event.target.value = '';
  });

  $('openPdfBtn').addEventListener('click', () => {
    const item = activeAttachment();
    if (!item) return;
    const win = window.open();
    if (win) {
      win.document.write(`<iframe title="${escapeHtml(item.name)}" src="${pdfSource(item)}" style="border:0;width:100vw;height:100vh"></iframe>`);
      win.document.close();
    }
  });

  $('pdfRefBtn').addEventListener('click', () => {
    const note = normalizeNote(activeNote());
    const item = activeAttachment(note);
    if (!item) {
      alert('先上传一个 PDF。');
      return;
    }
    const pageText = prompt('页码：', '1');
    if (!pageText) return;
    const page = Number.parseInt(pageText, 10);
    if (!Number.isFinite(page) || page < 1) {
      alert('页码需要是大于 0 的数字。');
      return;
    }
    const label = prompt('快捷方式名称：', `第 ${page} 页`) || `第 ${page} 页`;
    insertAtCursor(`[[pdf:${page}|${label}]]`);
    openPdfPage(page, item.id);
  });

  $('closeCanvasBtn').addEventListener('click', () => {
    $('handwriteDialog').close();
  });

  $('clearCanvasBtn').addEventListener('click', () => {
    clearCanvasToWhite();
  });

  $('penBlackBtn').addEventListener('click', () => setPen('#111827'));
  $('penRedBtn').addEventListener('click', () => setPen('#c2410c'));
  $('penBlueBtn').addEventListener('click', () => setPen('#1d4ed8'));
  $('eraserBtn').addEventListener('click', setEraser);

  $('penThinBtn').addEventListener('click', () => {
    penSize = 2;
  });

  $('penMidBtn').addEventListener('click', () => {
    penSize = 4;
  });

  $('penThickBtn').addEventListener('click', () => {
    penSize = 7;
  });

  $('zoomOutBtn').addEventListener('click', () => {
    if (canvasApi) canvasApi.setCanvasZoom(canvasZoom / 1.25);
  });

  $('zoomResetBtn').addEventListener('click', () => {
    if (canvasApi) canvasApi.resetCanvasView();
  });

  $('zoomInBtn').addEventListener('click', () => {
    if (canvasApi) canvasApi.setCanvasZoom(canvasZoom * 1.25);
  });

  $('saveCanvasBtn').addEventListener('click', () => {
    if (!canvasApi) return;
    const dataUrl = canvasApi.canvas.toDataURL('image/png');
    const label = canvasMode === 'image' ? '图片' : '手写';
    const note = normalizeNote(activeNote());
    if (editingImageId) {
      const image = note.images.find((item) => item.id === editingImageId);
      if (image) {
        image.dataUrl = dataUrl;
        image.updatedAt = now();
        note.updatedAt = now();
        editingImageId = null;
        updatePreview();
        persist();
        $('handwriteDialog').close();
        return;
      }
    }
    const image = {
      id: crypto.randomUUID(),
      type: canvasMode,
      name: label,
      dataUrl,
      createdAt: now(),
    };
    note.images.push(image);
    insertAtCursor(`\n[[image:${image.id}|${label}]]\n`);
    editingImageId = null;
    $('handwriteDialog').close();
  });

  $('studyModeBtn').addEventListener('click', () => {
    document.body.classList.remove('notes-only');
    $('studyModeBtn').classList.add('active');
    $('notesOnlyBtn').classList.remove('active');
  });

  $('notesOnlyBtn').addEventListener('click', () => {
    document.body.classList.add('notes-only');
    $('notesOnlyBtn').classList.add('active');
    $('studyModeBtn').classList.remove('active');
  });

  bindResizer('outlineResizer', '--outline-w', 140, 360, 'left');
  bindResizer('pdfResizer', '--pdf-w', 320, 820, 'right');

  $('deleteBtn').addEventListener('click', () => {
    if (state.notes.length <= 1) return;
    if (!confirm('删除当前笔记？')) return;
    state.notes = state.notes.filter((note) => note.id !== activeId);
    activeId = state.notes[0].id;
    persist();
    render();
  });

  $('settingsBtn').addEventListener('click', () => {
    $('ownerInput').value = settings.owner || '';
    $('repoInput').value = settings.repo || '';
    $('pathInput').value = settings.path || 'notes.json';
    $('tokenInput').value = settings.token || '';
    $('autoSyncInput').checked = settings.autoSync !== false;
    $('settingsDialog').showModal();
  });

  $('saveSettingsBtn').addEventListener('click', (event) => {
    event.preventDefault();
    settings = {
      owner: $('ownerInput').value.trim(),
      repo: $('repoInput').value.trim(),
      path: $('pathInput').value.trim() || 'notes.json',
      token: $('tokenInput').value.trim(),
      autoSync: $('autoSyncInput').checked,
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    $('settingsDialog').close();
    updateSyncState('GitHub ready');
    startAutoSync();
  });

  $('pullBtn').addEventListener('click', () => pullFromGithub());
  $('pushBtn').addEventListener('click', () => pushToGithub());
}

bindEvents();
render();
updateSyncState(settings.owner && settings.repo ? 'GitHub ready' : 'Local');
$('studyModeBtn').classList.add('active');
startAutoSync();
