/**
 * popup.js  â€“  YouTube Transcript â†’ PDF
 *
 * Flow:
 *   1. On load: query active tab â†’ verify it is a YouTube watch page.
 *   2. Inject content.js if needed, then PING to check transcript availability.
 *   3. On button click: send EXTRACT_TRANSCRIPT to content.js â†’ receive
 *      { title, blocks[] } â†’ build PDF with jsPDF â†’ trigger download.
 *
 * PDF structure mirrors the Xâ†’PDF reference extension:
 *   â€¢ Blue decorative top bar
 *   â€¢ Large bold video title + blue rule
 *   â€¢ h2 section headings (grey underline)
 *   â€¢ Body paragraphs at comfortable reading size
 *   â€¢ Footer rule + page numbers on every page
 */

'use strict';

// â”€â”€â”€ DOM refs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const urlBadge    = document.getElementById('urlBadge');
const urlText     = document.getElementById('urlText');
const warnBox     = document.getElementById('warnBox');
const progressArea= document.getElementById('progressArea');
const phaseLabel  = document.getElementById('phaseLabel');
const phasePct    = document.getElementById('phasePct');
const barFill     = document.getElementById('barFill');
const convertBtn  = document.getElementById('convertBtn');
const btnText     = document.getElementById('btnText');
const resultBanner= document.getElementById('resultBanner');
const resultIcon  = document.getElementById('resultIcon');
const resultText  = document.getElementById('resultText');

const phaseSteps = {
  inject:  document.getElementById('phase-inject'),
  extract: document.getElementById('phase-extract'),
  pdf:     document.getElementById('phase-pdf'),
};

const phaseOrder = ['inject', 'extract', 'pdf'];

let activeTabId      = null;
let isYouTubePage    = false;
let transcriptReady  = false;

function setWarning(message) {
  const target = warnBox.querySelector('.warn-text') || warnBox;
  target.textContent = message;
  warnBox.classList.add('show');
}

function clearWarning() {
  warnBox.classList.remove('show');
}

async function pingContentScript(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { action: 'PING' });
  } catch (_) {
    return null;
  }
}

async function ensureContentScript(tabId) {
  let pong = await pingContentScript(tabId);
  if (pong) return pong;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  } catch (_) {
    // Ignore here, second ping decides if injection worked.
  }

  pong = await pingContentScript(tabId);
  return pong;
}

// â”€â”€â”€ Background port (for PROGRESS relay) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const bgPort = chrome.runtime.connect({ name: 'popup' });
bgPort.onMessage.addListener((msg) => {
  if (msg.action === 'PROGRESS') handleProgress(msg.phase, msg.value);
});

// â”€â”€â”€ Init â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  activeTabId = tab.id;
  const url   = tab.url || '';

  // Truncate URL for display
  const display = url.replace(/^https?:\/\//, '').slice(0, 52) + (url.length > 64 ? '...' : '');
  urlText.textContent = display;

  isYouTubePage = /youtube\.com\/watch/i.test(url);

  if (!isYouTubePage) {
    setWarning('Navigate to a YouTube video page first.');
    return;
  }

  const pong = await ensureContentScript(activeTabId);
  if (pong && pong.hasTranscript) {
    transcriptReady = true;
    urlBadge.classList.add('valid');
    clearWarning();
    enableButton();
    return;
  }

  setWarning(pong?.reason || 'Transcript not detected. Open video captions/transcript and try again.');
})();

function enableButton() {
  convertBtn.disabled = false;
}

// â”€â”€â”€ Button Handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
convertBtn.addEventListener('click', async () => {
  if (!activeTabId || !isYouTubePage) return;

  resultBanner.className = 'result-banner';
  progressArea.classList.add('show');
  convertBtn.disabled = true;
  btnText.textContent  = 'Working...';

  setPhase('inject',  'done');     // Injection already completed at init
  setPhase('extract', 'active');
  setPhase('pdf',     'pending');
  updateBar('extract', 0);
  phaseLabel.textContent = 'Extracting transcript...';

  try {
    const pong = await ensureContentScript(activeTabId);
    if (!pong) {
      throw new Error('Could not connect to the YouTube tab. Refresh the tab and try again.');
    }
    if (!pong.hasTranscript) {
      throw new Error(pong.reason || 'Transcript is not available for this video.');
    }

    const response = await chrome.tabs.sendMessage(activeTabId, { action: 'EXTRACT_TRANSCRIPT' });

    if (!response || !response.ok) {
      throw new Error(response?.error || 'No response from page.');
    }

    setPhase('extract', 'done');
    setPhase('pdf',     'active');
    updateBar('pdf', 0);
    phaseLabel.textContent = 'Building PDF...';

    const filename = await buildPDF(response.title, response.blocks);

    setPhase('pdf', 'done');
    updateBar('pdf', 100);
    phaseLabel.textContent = 'Done!';
    phasePct.textContent   = '100%';
    showSuccess('Saved: ' + filename);

  } catch (err) {
    showError(err.message);
  } finally {
    convertBtn.disabled = false;
    btnText.textContent  = 'Convert to PDF';
  }
});

// â”€â”€â”€ Progress UI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function handleProgress(phase, value) {
  if (phase === 'extract') {
    updateBar('extract', value);
    phaseLabel.textContent = value < 100 ? 'Extracting transcript...' : 'Extraction complete.';
    if (value > 0 && value < 100) setPhase('extract', 'active');
    if (value === 100)            setPhase('extract', 'done');
  }
}

function updateBar(phase, value) {
  const idx     = phaseOrder.indexOf(phase);
  const overall = Math.round((idx * 33) + (value / 100) * 33);
  barFill.style.width  = Math.min(overall, 99) + '%';
  phasePct.textContent = Math.min(overall, 99) + '%';
}

function setPhase(phase, state) {
  const el = phaseSteps[phase];
  if (!el) return;
  el.classList.remove('active', 'done', 'pending');
  if (state !== 'reset') el.classList.add(state);
}

// â”€â”€â”€ PDF Builder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function buildPDF(title, blocks) {
  if (typeof window.jspdf === 'undefined') {
    throw new Error('jsPDF not loaded. Ensure lib/jspdf.umd.min.js is present.');
  }

  const { jsPDF } = window.jspdf;

  const PAGE_W   = 210;
  const PAGE_H   = 297;
  const MARGIN_X = 22;
  const MARGIN_Y = 28;
  const CONTENT_W = PAGE_W - MARGIN_X * 2;

  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });

  // â”€â”€ Typography scale â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const T = {
    title:  { size: 22, style: 'bold',   lineH: 1.15, spaceBefore: 0,  spaceAfter: 3,   rule: true  },
    h2:     { size: 15, style: 'bold',   lineH: 1.2,  spaceBefore: 8,  spaceAfter: 2.5, rule: true  },
    h3:     { size: 12, style: 'bold',   lineH: 1.2,  spaceBefore: 6,  spaceAfter: 1.5, rule: false },
    p:      { size: 11, style: 'normal', lineH: 1.45, spaceBefore: 0,  spaceAfter: 4.5 },
    meta:   { size: 9,  style: 'italic', lineH: 1.2,  spaceBefore: 0,  spaceAfter: 4   },
  };

  let cursorY = MARGIN_Y;

  function lineHeightMM(sizeInPt, multiplier) {
    return sizeInPt * 0.3528 * multiplier;
  }

  function checkPage(needed) {
    if (cursorY + needed > PAGE_H - MARGIN_Y - 10) {
      doc.addPage();
      cursorY = MARGIN_Y;
    }
  }

  function drawRule(y, rgb) {
    doc.setDrawColor(...rgb);
    doc.setLineWidth(0.25);
    doc.line(MARGIN_X, y, PAGE_W - MARGIN_X, y);
  }

  function renderBlock(type, text) {
    const s   = T[type] || T.p;
    const lh  = lineHeightMM(s.size, s.lineH);
    const indent = s.indent || 0;

    doc.setFontSize(s.size);
    doc.setFont('helvetica', s.style);
    doc.setTextColor(22, 22, 28);

    const lines = doc.splitTextToSize(text, CONTENT_W - indent);

    if (s.spaceBefore > 0 && cursorY > MARGIN_Y + 4) {
      cursorY += s.spaceBefore;
    }

    checkPage(lines.length * lh + (s.spaceAfter || 0) + 4);

    for (const line of lines) {
      checkPage(lh + 2);
      doc.text(line, MARGIN_X + indent, cursorY);
      cursorY += lh;
    }

    if (s.rule) {
      cursorY += 1.5;
      const ruleRgb = type === 'title'
        ? [79, 142, 247]   // blue under title
        : [190, 190, 200]; // grey under h2
      drawRule(cursorY, ruleRgb);
      cursorY += 2.5;
    }

    cursorY += s.spaceAfter || 0;
  }

  // â”€â”€ Decorative top bar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  doc.setFillColor(79, 142, 247);
  doc.rect(0, 0, PAGE_W, 5, 'F');
  cursorY = MARGIN_Y;

  // â”€â”€ Video title â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  renderBlock('title', title);

  // â”€â”€ Source / date meta line â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const now = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  renderBlock('meta', 'Exported from YouTube  |  ' + now);

  // â”€â”€ Body blocks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  for (const block of blocks) {
    renderBlock(block.type, block.text);
  }

  // â”€â”€ Page numbers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(155, 155, 165);
    drawRule(PAGE_H - 11, [210, 210, 218]);
    doc.text('Exported via YouTube Transcript â†’ PDF', MARGIN_X, PAGE_H - 6.5);
    const pageLabel = 'Page ' + i + ' of ' + pageCount;
    doc.text(pageLabel, PAGE_W - MARGIN_X - doc.getTextWidth(pageLabel) - 1, PAGE_H - 6.5);
  }

  // â”€â”€ Save â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const safeName = title
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, '_')
    .slice(0, 80);
  const filename = (safeName || 'YouTube_Transcript') + '.pdf';
  doc.save(filename);
  return filename;
}

// â”€â”€â”€ Feedback Banners â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function showSuccess(msg) {
  resultBanner.className = 'result-banner success show';
  resultIcon.innerHTML   = '<polyline points="20 6 9 17 4 12" stroke-width="2.5" stroke-linecap="round"/>';
  resultText.textContent = msg;
  barFill.style.width    = '100%';
  phasePct.textContent   = '100%';
}

function showError(msg) {
  resultBanner.className = 'result-banner error show';
  resultIcon.innerHTML   = '<line x1="18" y1="6" x2="6" y2="18" stroke-width="2.5"/><line x1="6" y1="6" x2="18" y2="18" stroke-width="2.5"/>';
  resultText.textContent = msg;
  progressArea.classList.remove('show');
}
