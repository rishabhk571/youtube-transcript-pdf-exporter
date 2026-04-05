/**
 * content.js - YouTube Transcript -> PDF
 *
 * v4 patch summary:
 * 1) Caption-track extraction first, so DOM selector changes do not break export.
 * 2) DOM scraping still exists as fallback.
 * 3) Listener registration is reinjection-safe without global const collisions.
 * 4) PING now reports capability details (caption-track vs DOM transcript).
 * 5) __ytTranscriptDebug() returns structured diagnostics.
 */
(function () {
  'use strict';

  const LOG_PREFIX = '[YT-PDF]';
  const LISTENER_KEY = '__ytPdfOnMessage';
  const DEBUG_FN_KEY = '__ytTranscriptDebug';
  const TIMESTAMP_RE = /^\d{1,2}:\d{2}(?::\d{2})?$/;

  const DOM_SELECTORS = {
    panel: [
      'yt-section-list-renderer[data-target-id="PAmodern_transcript_view"]',
      'yt-section-list-renderer[data-target-id*="transcript"]',
      'ytd-transcript-segment-list-renderer',
      'ytd-transcript-renderer',
      'ytd-transcript-search-panel-renderer',
      'ytd-engagement-panel-section-list-renderer[target-id*="transcript"] ytd-transcript-renderer',
      'ytd-engagement-panel-section-list-renderer[target-id*="transcript"]',
    ],
    container: [
      '.ytSectionListRendererContents',
      'yt-item-section-renderer',
      '#segments-container',
      '#body',
      '#content',
      '[role="list"]',
    ],
    segment: [
      'transcript-segment-view-model',
      '.ytwTranscriptSegmentViewModelHost',
      'ytd-transcript-segment-renderer',
      '[data-start-ms]',
      '[role="listitem"]',
    ],
    segmentText: [
      'span.yt-core-attributed-string[role="text"]',
      '.yt-core-attributed-string[role="text"]',
      'span[role="text"]',
      'yt-formatted-string.segment-text',
      '[id="segment-text"]',
      '.segment-text',
      'yt-formatted-string',
      'span',
    ],
    timestamp: [
      '.ytwTranscriptSegmentViewModelTimestamp',
      '.segment-timestamp',
      '[class*="timestamp"]',
      'yt-formatted-string.segment-timestamp',
    ],
    section: [
      'yt-item-section-renderer',
      'ytd-transcript-section-header-renderer',
    ],
    sectionHeading: [
      'h3.ytwTimelineChapterViewModelTitle',
      'timeline-chapter-view-model h3',
      '[role="button"][aria-label]',
      'h3',
    ],
    title: [
      'h1.ytd-watch-metadata yt-formatted-string',
      '#title h1 yt-formatted-string',
      '#title h1',
      'h1.title',
      '#above-the-fold #title h1',
    ],
  };

  function logDebug(...args) {
    console.debug(LOG_PREFIX, ...args);
  }

  function logWarn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  function safeText(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\u200b-\u200d\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/[^\u0000-\u00FF]/g, ' ')
      .trim();
  }

  function firstMatch(root, selectors) {
    if (!root) return { el: null, sel: null };
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el) return { el, sel };
    }
    return { el: null, sel: null };
  }

  function firstMatchAll(root, selectors) {
    if (!root) return { els: [], sel: null };
    for (const sel of selectors) {
      const els = root.querySelectorAll(sel);
      if (els && els.length > 0) return { els: Array.from(els), sel };
    }
    return { els: [], sel: null };
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function parseTimestampToMs(text) {
    const raw = safeText(text);
    if (!raw || !TIMESTAMP_RE.test(raw)) return -1;

    const parts = raw.split(':').map((v) => Number(v));
    if (parts.some((n) => Number.isNaN(n))) return -1;

    if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
    return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  }

  function getVideoTitle() {
    const fromDom = firstMatch(document, DOM_SELECTORS.title).el;
    if (fromDom) {
      const text = safeText(fromDom.innerText || fromDom.textContent || '');
      if (text) return text;
    }
    return safeText(document.title.replace(/\s*[-|]\s*YouTube\s*$/i, '')) || 'YouTube Video';
  }

  function tryJsonParse(value) {
    try {
      return JSON.parse(value);
    } catch (_) {
      return null;
    }
  }

  function getPlayerResponse() {
    if (window.ytInitialPlayerResponse && typeof window.ytInitialPlayerResponse === 'object') {
      return window.ytInitialPlayerResponse;
    }

    const rawPlayerResponse = window.ytplayer?.config?.args?.raw_player_response;
    if (rawPlayerResponse && typeof rawPlayerResponse === 'object') {
      return rawPlayerResponse;
    }

    const playerResponseJson = window.ytplayer?.config?.args?.player_response;
    if (typeof playerResponseJson === 'string') {
      const parsed = tryJsonParse(playerResponseJson);
      if (parsed) return parsed;
    }

    const ytdApp = document.querySelector('ytd-app');
    const appPlayerResponse = ytdApp?.data?.response?.playerResponse;
    if (appPlayerResponse && typeof appPlayerResponse === 'object') {
      return appPlayerResponse;
    }

    return null;
  }

  function getCaptionTracks() {
    const playerResponse = getPlayerResponse();
    const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    return Array.isArray(tracks) ? tracks : [];
  }

  function isAutoTrack(track) {
    const vssId = String(track?.vssId || '');
    return track?.kind === 'asr' || vssId.startsWith('a.');
  }

  function buildPreferredLanguages() {
    const langs = [];
    const pageLang = safeText(document.documentElement?.lang || '').toLowerCase();
    const browserLang = safeText(navigator.language || '').toLowerCase();
    if (pageLang) langs.push(pageLang);
    if (browserLang) langs.push(browserLang);
    langs.push('en-us', 'en');
    return Array.from(new Set(langs.filter(Boolean)));
  }

  function pickBestTrack(tracks) {
    if (!tracks.length) return null;

    const preferred = buildPreferredLanguages();
    const primaryPreferred = preferred.map((l) => l.split('-')[0]);
    const manualTracks = tracks.filter((track) => !isAutoTrack(track));
    const autoTracks = tracks.filter((track) => isAutoTrack(track));

    const match = (list, langCode) =>
      list.find((track) => safeText(track.languageCode || '').toLowerCase() === langCode);

    const matchPrimary = (list, langCode) =>
      list.find((track) => safeText(track.languageCode || '').toLowerCase().split('-')[0] === langCode);

    const chooseFrom = (list) => {
      if (!list.length) return null;

      for (const lang of preferred) {
        const found = match(list, lang);
        if (found) return found;
      }
      for (const lang of primaryPreferred) {
        const found = matchPrimary(list, lang);
        if (found) return found;
      }
      return list[0];
    };

    return chooseFrom(manualTracks) || chooseFrom(autoTracks) || tracks[0];
  }

  function withJson3Format(url) {
    try {
      const u = new URL(url, location.origin);
      u.searchParams.set('fmt', 'json3');
      return u.toString();
    } catch (_) {
      if (url.includes('fmt=json3')) return url;
      return `${url}${url.includes('?') ? '&' : '?'}fmt=json3`;
    }
  }

  function parseJson3Cues(payload) {
    const events = Array.isArray(payload?.events) ? payload.events : [];
    const cues = [];

    for (const event of events) {
      if (!Array.isArray(event?.segs)) continue;

      const raw = event.segs.map((seg) => seg?.utf8 || '').join('');
      const text = safeText(raw);
      if (!text) continue;
      if (/^\[.*\]$/.test(text)) continue;

      const startMs = Number(event?.tStartMs || 0);
      cues.push({
        startMs: Number.isFinite(startMs) ? startMs : 0,
        text,
      });
    }

    return cues;
  }

  function parseXmlCues(xmlText) {
    const parsed = new DOMParser().parseFromString(xmlText, 'text/xml');
    const nodes = Array.from(parsed.querySelectorAll('text'));
    const cues = [];

    for (const node of nodes) {
      const text = safeText(node.textContent || '');
      if (!text) continue;
      if (/^\[.*\]$/.test(text)) continue;

      const startSeconds = Number(node.getAttribute('start') || '0');
      const startMs = Number.isFinite(startSeconds) ? Math.round(startSeconds * 1000) : 0;
      cues.push({ startMs, text });
    }

    return cues;
  }

  async function fetchCaptionCues(track) {
    const errors = [];
    const json3Url = withJson3Format(track.baseUrl);

    try {
      const res = await fetch(json3Url, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const payload = await res.json();
      const cues = parseJson3Cues(payload);
      if (cues.length > 0) return { cues, format: 'json3', sourceUrl: json3Url };
      errors.push('json3 returned zero cues');
    } catch (error) {
      errors.push(`json3 failed: ${error.message}`);
    }

    try {
      const res = await fetch(track.baseUrl, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const xmlText = await res.text();
      const cues = parseXmlCues(xmlText);
      if (cues.length > 0) return { cues, format: 'xml', sourceUrl: track.baseUrl };
      errors.push('xml returned zero cues');
    } catch (error) {
      errors.push(`xml failed: ${error.message}`);
    }

    throw new Error(errors.join(' | '));
  }

  function buildParagraphBlocks(cues) {
    if (!Array.isArray(cues) || cues.length === 0) return [];

    const SENTENCE_WORD_LIMIT = 30;
    const PARAGRAPH_WORD_LIMIT = 120;
    const GAP_BREAK_MS = 6000;

    const blocks = [];
    let sentenceTokens = [];
    let sentenceWords = 0;
    let paragraphSentences = [];
    let paragraphWords = 0;
    let previousStartMs = null;

    function flushSentence(forcePunctuation) {
      if (!sentenceTokens.length) return;

      let sentence = sentenceTokens.join(' ').replace(/\s+/g, ' ').trim();
      sentenceTokens = [];
      sentenceWords = 0;

      if (!sentence) return;
      sentence = sentence.charAt(0).toUpperCase() + sentence.slice(1);
      if (forcePunctuation || !/[.!?]$/.test(sentence)) sentence += '.';

      paragraphSentences.push(sentence);
      paragraphWords += sentence.split(/\s+/).filter(Boolean).length;
    }

    function flushParagraph() {
      if (!paragraphSentences.length) return;

      const paragraph = paragraphSentences.join(' ').replace(/\s+/g, ' ').trim();
      paragraphSentences = [];
      paragraphWords = 0;

      if (paragraph) {
        blocks.push({ type: 'p', text: paragraph });
      }
    }

    for (const cue of cues) {
      const text = safeText(cue?.text);
      if (!text || TIMESTAMP_RE.test(text)) continue;

      const startMs = Number(cue?.startMs || 0);
      const gapMs = previousStartMs === null ? 0 : Math.max(0, startMs - previousStartMs);
      if (gapMs > GAP_BREAK_MS) {
        flushSentence(true);
        flushParagraph();
      }
      previousStartMs = startMs;

      sentenceTokens.push(text);
      sentenceWords += text.split(/\s+/).filter(Boolean).length;

      if (/[.!?]$/.test(text) || sentenceWords >= SENTENCE_WORD_LIMIT) {
        flushSentence(false);
      }

      if (paragraphWords >= PARAGRAPH_WORD_LIMIT) {
        flushParagraph();
      }
    }

    flushSentence(true);
    flushParagraph();
    return blocks;
  }

  async function extractFromCaptionTrack(title) {
    const tracks = getCaptionTracks();
    if (!tracks.length) {
      return { ok: false, error: 'No caption tracks found in player response.' };
    }

    const track = pickBestTrack(tracks);
    if (!track?.baseUrl) {
      return { ok: false, error: 'Caption track is missing baseUrl.' };
    }

    const fetched = await fetchCaptionCues(track);
    const blocks = buildParagraphBlocks(fetched.cues);

    if (!blocks.length) {
      return { ok: false, error: 'Caption track fetched but parsed transcript is empty.' };
    }

    return {
      ok: true,
      title,
      blocks,
      meta: {
        method: 'caption-track',
        format: fetched.format,
        languageCode: track.languageCode || '',
        autoGenerated: isAutoTrack(track),
      },
    };
  }

  function getDomState() {
    const panel = firstMatch(document, DOM_SELECTORS.panel);
    let segments = { els: [], sel: null };
    if (panel.el) segments = firstMatchAll(panel.el, DOM_SELECTORS.segment);

    let container = { el: null, sel: null };
    if (!segments.els.length && panel.el) {
      container = firstMatch(panel.el, DOM_SELECTORS.container);
      if (container.el) segments = firstMatchAll(container.el, DOM_SELECTORS.segment);
    }

    if (!segments.els.length && !container.el) {
      container = firstMatch(document, DOM_SELECTORS.container);
      if (container.el) segments = firstMatchAll(container.el, DOM_SELECTORS.segment);
    }

    if (!segments.els.length) segments = firstMatchAll(document, DOM_SELECTORS.segment);

    const sectionRoot = panel.el || container.el || document;
    const sections = firstMatchAll(sectionRoot, DOM_SELECTORS.section);

    return {
      panel: panel.el,
      panelSelector: panel.sel,
      container: container.el,
      containerSelector: container.sel,
      segments: segments.els,
      segmentSelector: segments.sel,
      sections: sections.els,
      sectionSelector: sections.sel,
    };
  }

  function getSectionHeading(sectionEl) {
    if (!sectionEl) return '';

    for (const selector of DOM_SELECTORS.sectionHeading) {
      const node = sectionEl.querySelector(selector);
      if (!node) continue;

      if (selector === '[role="button"][aria-label]') {
        const ariaLabel = safeText(node.getAttribute('aria-label') || '');
        if (ariaLabel) return ariaLabel;
      }

      const text = safeText(node.innerText || node.textContent || '');
      if (text) return text;
    }

    return '';
  }

  function extractSegmentText(segment) {
    for (const selector of DOM_SELECTORS.segmentText) {
      const node = segment.querySelector(selector);
      if (!node) continue;

      const text = safeText(node.innerText || node.textContent || '');
      if (text && !TIMESTAMP_RE.test(text)) return text;
    }

    const clone = segment.cloneNode(true);
    for (const selector of DOM_SELECTORS.timestamp) {
      const nodes = clone.querySelectorAll(selector);
      for (const node of nodes) node.remove();
    }
    const text = safeText(clone.innerText || clone.textContent || '');
    return TIMESTAMP_RE.test(text) ? '' : text;
  }

  function buildCuesFromSegments(segments) {
    const cues = [];

    segments.forEach((segment, index) => {
      const text = extractSegmentText(segment);
      if (!text) return;

      const attrStart =
        segment.getAttribute('data-start-ms') ||
        segment.getAttribute('start-ms') ||
        segment.dataset?.startMs;

      let startMs = Number(attrStart);
      if (!Number.isFinite(startMs)) {
        const tsNode = firstMatch(segment, DOM_SELECTORS.timestamp).el;
        startMs = parseTimestampToMs(tsNode ? tsNode.innerText || tsNode.textContent || '' : '');
      }
      if (!Number.isFinite(startMs) || startMs < 0) {
        startMs = index * 2000;
      }

      cues.push({ startMs, text });
    });

    return cues;
  }

  async function waitForDomTranscript(timeoutMs = 12000, intervalMs = 250) {
    const startedAt = Date.now();

    while (Date.now() - startedAt <= timeoutMs) {
      const state = getDomState();
      if (state.segments.length > 0) return state;
      await wait(intervalMs);
    }

    return getDomState();
  }

  async function extractFromDom(title) {
    const state = await waitForDomTranscript();
    if (!state.segments.length) {
      return {
        ok: false,
        error: `DOM transcript not found. Tried panel selectors: ${DOM_SELECTORS.panel.join(', ')}`,
      };
    }

    const sectionBlocks = [];
    let usedSections = false;

    for (const sectionEl of state.sections) {
      const sectionSegments = firstMatchAll(sectionEl, DOM_SELECTORS.segment).els;
      if (!sectionSegments.length) continue;

      const cues = buildCuesFromSegments(sectionSegments);
      if (!cues.length) continue;

      const heading = getSectionHeading(sectionEl);
      const blocksForSection = buildParagraphBlocks(cues);
      if (!blocksForSection.length) continue;

      usedSections = true;
      if (heading) {
        sectionBlocks.push({ type: 'h2', text: heading });
      }
      sectionBlocks.push(...blocksForSection);
    }

    const blocks = sectionBlocks.length
      ? sectionBlocks
      : buildParagraphBlocks(buildCuesFromSegments(state.segments));

    if (!blocks.length) {
      return {
        ok: false,
        error: 'DOM segments were found but text extraction produced no content.',
      };
    }

    return {
      ok: true,
      title,
      blocks,
      meta: {
        method: 'dom-fallback',
        usedSections,
        panelSelector: state.panelSelector,
        containerSelector: state.containerSelector,
        sectionSelector: state.sectionSelector,
        segmentSelector: state.segmentSelector,
      },
    };
  }

  function detectAvailability() {
    const tracks = getCaptionTracks();
    const dom = getDomState();
    const hasCaptionTrack = tracks.length > 0;
    const hasDomPanel = Boolean(dom.panel);
    const hasDomTranscript = dom.segments.length > 0;
    const hasTranscript = hasCaptionTrack || hasDomTranscript;

    let reason = 'Transcript is available.';
    if (!hasTranscript) {
      if (!/youtube\.com\/watch/i.test(location.href)) {
        reason = 'This tab is not a YouTube watch page.';
      } else if (hasDomPanel) {
        reason = 'Transcript panel was found, but transcript segments are not loaded yet.';
      } else {
        reason = 'No transcript data detected yet. Try waiting a few seconds or opening captions/transcript.';
      }
    }

    return {
      hasTranscript,
      hasCaptionTrack,
      hasDomPanel,
      hasDomTranscript,
      captionTrackCount: tracks.length,
      domSegmentCount: dom.segments.length,
      reason,
    };
  }

  function buildDebugSnapshot() {
    const tracks = getCaptionTracks();
    const selectedTrack = pickBestTrack(tracks);
    const dom = getDomState();

    return {
      url: location.href,
      title: getVideoTitle(),
      captionTracks: tracks.map((track) => ({
        languageCode: track.languageCode || '',
        name: safeText(track.name?.simpleText || ''),
        vssId: track.vssId || '',
        kind: track.kind || '',
        hasBaseUrl: Boolean(track.baseUrl),
      })),
      selectedTrack: selectedTrack
        ? {
            languageCode: selectedTrack.languageCode || '',
            vssId: selectedTrack.vssId || '',
            kind: selectedTrack.kind || '',
            autoGenerated: isAutoTrack(selectedTrack),
          }
        : null,
      dom: {
        panelFound: Boolean(dom.panel),
        panelSelector: dom.panelSelector,
        containerSelector: dom.containerSelector,
        sectionSelector: dom.sectionSelector,
        sectionCount: dom.sections.length,
        segmentSelector: dom.segmentSelector,
        segmentCount: dom.segments.length,
        firstSegmentPreview: dom.segments.length ? extractSegmentText(dom.segments[0]).slice(0, 160) : '',
      },
      note: 'If this function is undefined in DevTools, switch console context to the extension content script.',
    };
  }

  function reportProgress(value) {
    try {
      chrome.runtime.sendMessage({ action: 'PROGRESS', phase: 'extract', value });
    } catch (_) {
      // Popup may be closed; ignore.
    }
  }

  async function extractTranscript() {
    const title = getVideoTitle();
    const errors = [];

    try {
      const byCaptionTrack = await extractFromCaptionTrack(title);
      if (byCaptionTrack.ok) {
        logDebug('Extraction succeeded via caption-track path.', byCaptionTrack.meta);
        return byCaptionTrack;
      }
      errors.push(`caption-track path: ${byCaptionTrack.error}`);
    } catch (error) {
      errors.push(`caption-track path: ${error.message}`);
    }

    try {
      const byDom = await extractFromDom(title);
      if (byDom.ok) {
        logDebug('Extraction succeeded via DOM fallback path.', byDom.meta);
        return byDom;
      }
      errors.push(`DOM path: ${byDom.error}`);
    } catch (error) {
      errors.push(`DOM path: ${error.message}`);
    }

    logWarn('Extraction failed.', errors);
    return {
      ok: false,
      error: `Could not extract transcript. ${errors.join(' | ')}`,
    };
  }

  const onMessage = (message, _sender, sendResponse) => {
    if (!message || typeof message.action !== 'string') return false;

    if (message.action === 'PING') {
      const availability = detectAvailability();
      sendResponse({
        ready: true,
        url: location.href,
        ...availability,
      });
      return false;
    }

    if (message.action === 'EXTRACT_TRANSCRIPT') {
      (async () => {
        try {
          reportProgress(0);
          const result = await extractTranscript();
          reportProgress(100);
          sendResponse(result);
        } catch (error) {
          console.error(LOG_PREFIX, 'Extraction error:', error);
          sendResponse({
            ok: false,
            error: error?.message || 'Unknown extraction error.',
          });
        }
      })();
      return true;
    }

    return false;
  };

  if (window[LISTENER_KEY]) {
    chrome.runtime.onMessage.removeListener(window[LISTENER_KEY]);
  }
  window[LISTENER_KEY] = onMessage;
  chrome.runtime.onMessage.addListener(onMessage);

  window[DEBUG_FN_KEY] = () => {
    const snapshot = buildDebugSnapshot();
    console.group(`${LOG_PREFIX} Transcript diagnostic`);
    console.log(snapshot);
    console.groupEnd();
    return snapshot;
  };

  logDebug('content.js v4 loaded.');
})();
