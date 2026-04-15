// ============================================================
//  LoRa Messenger – Web App (app.js)
//  WhatsApp-style image send & receive
// ============================================================

// ─── State ───────────────────────────────────────────────────
let port, reader, outputStream;
let inputDone, outputDone, inputStream;
let txCount = 0;
let rxCount = 0;

let chatHistory = JSON.parse(localStorage.getItem('lora_chat_history') || '[]');

let cancelImgTx = false;
function mkId() { return Math.random().toString(36).substr(2, 6); }

// Resolve function for TX coordination during images
let resolveTxAwait = null;

// Image reassembly state (for *incoming* image packets)
const imgRxSessions = {};  // key = filename, value = { total, chunks[] }

// ─── DOM Refs ─────────────────────────────────────────────────
const connectBtn     = document.getElementById('connectBtn');
const disconnectBtn  = document.getElementById('disconnectBtn');
const baudRateSelect = document.getElementById('baudRate');
const statusDot      = document.getElementById('statusDot');
const statusText     = document.getElementById('statusText');
const contactStatus  = document.getElementById('contactStatus');
const chatMessages   = document.getElementById('chatMessages');
const msgForm        = document.getElementById('msgForm');
const msgInput       = document.getElementById('msgInput');
const sendBtn        = document.getElementById('sendBtn');
const clearChatBtn   = document.getElementById('clearChatBtn');
const debugLog       = document.getElementById('debugLog');
const myNameInput    = document.getElementById('myName');
const rssiVal        = document.getElementById('rssiVal');
const txCountEl      = document.getElementById('txCount');
const rxCountEl      = document.getElementById('rxCount');
const imgBtn         = document.getElementById('imgBtn');
const imgFileInput   = document.getElementById('imgFileInput');

// ─── Image Lightbox ───────────────────────────────────────────
const lightbox       = document.getElementById('imgLightbox');
const lightboxImg    = document.getElementById('lightboxImg');
const lightboxClose  = document.getElementById('lightboxClose');
const lightboxDl     = document.getElementById('lightboxDl');

lightboxClose && lightboxClose.addEventListener('click', closeLightbox);
lightbox && lightbox.addEventListener('click', (e) => { if (e.target === lightbox) closeLightbox(); });

function openLightbox(src, filename) {
  lightboxImg.src = src;
  lightboxDl.href = src;
  lightboxDl.download = filename || 'image';
  lightbox.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  lightbox.classList.remove('active');
  lightboxImg.src = '';
  document.body.style.overflow = '';
}

// ─── Image Transfer Constants ─────────────────────────────────
// LoRa max payload = 255 bytes
// "IMG:DATA:filename:idx:" = ~20 bytes header
// Remaining for base64 payload: ~200 chars → encodes ~150 bytes binary
const IMG_CHUNK_RAW_BYTES = 150;

// ─── Browser Check ────────────────────────────────────────────
if (!('serial' in navigator)) {
  addSysMsg('⚠️ Web Serial API not supported. Please use Chrome or Edge browser.');
  connectBtn.disabled = true;
}

// ─── Connect ──────────────────────────────────────────────────
async function connectPort() {
  try {
    port = await navigator.serial.requestPort();
    const baud = parseInt(baudRateSelect.value, 10);
    await port.open({ baudRate: baud });

    const encoder = new TextEncoderStream();
    outputDone    = encoder.readable.pipeTo(port.writable);
    outputStream  = encoder.writable;

    const decoder = new TextDecoderStream();
    inputDone     = port.readable.pipeTo(decoder.writable);
    inputStream   = decoder.readable;

    setConnected(true);
    addSysMsg('🔌 Board connected at ' + baud + ' baud');
    readLoop();

  } catch (err) {
    addSysMsg('❌ Connection failed: ' + err.message);
  }
}

// ─── Disconnect ───────────────────────────────────────────────
async function disconnectPort() {
  try {
    if (reader)       await reader.cancel().catch(() => {});
    if (inputDone)    await inputDone.catch(() => {});
    if (outputStream) {
      const w = outputStream.getWriter();
      await w.close().catch(() => {});
      w.releaseLock();
    }
    if (outputDone)   await outputDone.catch(() => {});
    if (port)         await port.close().catch(() => {});
  } catch (e) { /* ignore */ }

  port = null; reader = null; outputStream = null;
  setConnected(false);
  addSysMsg('🔌 Board disconnected');
}

// ─── Read Loop ────────────────────────────────────────────────
async function readLoop() {
  reader = inputStream.getReader();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;

      buffer += value;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r/g, '').trim();
        buffer = buffer.slice(idx + 1);
        if (line) handleIncoming(line);
      }
    }
  } catch (e) {
    if (!e.message.includes('cancelled')) {
      addSysMsg('⚠️ Read error: ' + e.message);
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── Handle Incoming Lines from Board ─────────────────────────
function handleIncoming(line) {
  addDebug('← ' + line);

  if (line === 'READY') {
    addSysMsg('📡 LoRa radio initialised and ready!');
    contactStatus.textContent = 'LoRa P2P · 868 MHz · Listening...';

  } else if (line.startsWith('RX:')) {
    const payload = line.slice(3);
    rxCount++;
    rxCountEl.textContent = rxCount;
    handleRxPayload(payload);

  } else if (line.startsWith('TX_OK:')) {
    txCount++;
    txCountEl.textContent = txCount;
    if (resolveTxAwait) {
      resolveTxAwait();
      resolveTxAwait = null;
    }

  } else if (line.startsWith('TX_ERR:')) {
    addSysMsg('⚠️ Transmit error: ' + line.slice(7));
    if (resolveTxAwait) {
      resolveTxAwait();
      resolveTxAwait = null;
    }

  } else if (line.startsWith('ERR:')) {
    addSysMsg('❌ Radio error code: ' + line.slice(4));
  }
}

// ─── Handle an RX payload (text OR image protocol) ────────────
function handleRxPayload(payload) {
  // ── Command Protocol ──────────────────────────────────────────
  if (payload.startsWith('CMD:DEL:')) {
    const delId = payload.split(':')[2];
    deleteMessageById(delId);
    return;
  }

  // ── Image Cancel ─────────────────────────────────────────────
  if (payload.startsWith('IMG:CANCEL:')) {
    const fname = payload.slice('IMG:CANCEL:'.length);
    delete imgRxSessions[fname];
    addSysMsg('🚫 Image transfer "' + fname + '" was cancelled by sender.');
    return;
  }

  // ── Image Start ──────────────────────────────────────────────
  if (payload.startsWith('IMG:START:')) {
    // IMG:START:<filename>:<totalChunks>:<msgId>
    const parts  = payload.split(':');
    const fname  = parts[2] || 'image.bmp';
    const total  = parseInt(parts[3], 10);
    const msgId  = parts[4] || mkId();
    imgRxSessions[fname] = { total, chunks: [], msgId };
    addSysMsg('📷 Receiving image "' + fname + '" (' + total + ' chunks)...');
    return;
  }

  // ── Image Data ───────────────────────────────────────────────
  if (payload.startsWith('IMG:DATA:')) {
    // IMG:DATA:<filename>:<chunkIdx>:<base64data>
    const rest    = payload.slice('IMG:DATA:'.length);
    const colon1  = rest.indexOf(':');
    const colon2  = rest.indexOf(':', colon1 + 1);
    const fname   = rest.slice(0, colon1);
    const idx     = parseInt(rest.slice(colon1 + 1, colon2), 10);
    const b64data = rest.slice(colon2 + 1);

    if (!imgRxSessions[fname]) {
      imgRxSessions[fname] = { total: null, chunks: [], msgId: mkId() };
    }
    imgRxSessions[fname].chunks[idx] = b64data;
    addDebug('  IMG chunk ' + idx + ' received (' + b64data.length + ' chars)');
    return;
  }

  // ── Image End ────────────────────────────────────────────────
  if (payload.startsWith('IMG:END:')) {
    const fname   = payload.slice('IMG:END:'.length);
    const session = imgRxSessions[fname];
    if (!session) return;

    const allB64 = session.chunks.join('');

    let missing = 0;
    for (let i = 0; i < session.total; i++) {
      if (!session.chunks[i]) missing++;
    }
    if (missing > 0) {
      addSysMsg('⚠️ Image "' + fname + '" has ' + missing + ' missing chunks. May be corrupted.');
    }

    // Detect MIME type from base64 signature
    const mimeType = detectMime(allB64);

    // Convert base64 → Blob → Object URL (like how WhatsApp handles it natively)
    const blobUrl = base64ToBlobUrl(allB64, mimeType);

    addImageBubble('Remote', fname, blobUrl, allB64, mimeType, 'received', null, false, session.msgId);
    delete imgRxSessions[fname];
    return;
  }

  // ── Regular text message ────────────────────────────────────
  if (payload.startsWith('MSG:')) {
    // MSG:id:sender:text
    const parts = payload.split(':');
    const msgId = parts[1];
    const sender = parts[2];
    const text = parts.slice(3).join(':').trim();
    addBubble(sender, text, 'received', null, false, msgId);
    return;
  }

  // Legacy fallback
  const colonIdx = payload.indexOf(':');
  let sender = 'Remote';
  let text   = payload;
  if (colonIdx > 0 && colonIdx < 20) {
    sender = payload.slice(0, colonIdx).trim();
    text   = payload.slice(colonIdx + 1).trim();
  }
  addBubble(sender, text, 'received', null, false, mkId());
}

// ─── Send a text message ──────────────────────────────────────
async function sendMessage(text) {
  if (!outputStream || !text.trim()) return;

  const name    = myNameInput.value.trim() || 'Me';
  const msgId   = mkId();
  const payload = `MSG:${msgId}:${name}:${text.trim()}`;

  if (payload.length > 234) {
    addSysMsg('⚠️ Message too long! Max ~200 characters.');
    return;
  }

  addBubble('You', text.trim(), 'sent', null, false, msgId);
  await writeSerial(payload);
}

// ─── Send an Image file over LoRa (chunked) ───────────────────
async function sendImage(file) {
  if (!outputStream) return;
  if (!file.type.startsWith('image/')) {
    addSysMsg('⚠️ Please upload a valid image file (JPG, PNG, BMP, etc).');
    return;
  }

  addSysMsg('📷 Reading image "' + file.name + '"...');

  const arrayBuf = await file.arrayBuffer();
  const bytes    = new Uint8Array(arrayBuf);

  // Convert raw bytes → base64
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const fullB64 = btoa(binary);

  const totalBytes  = fullB64.length;
  const totalChunks = Math.ceil(totalBytes / IMG_CHUNK_RAW_BYTES);
  const mimeType    = file.type || detectMime(fullB64);

  // Use Object URL for local preview — fast, no base64 data URI
  const localBlobUrl = URL.createObjectURL(file);
  const msgId = mkId();

  // Show sent bubble with local preview immediately
  addImageBubble('You', file.name, localBlobUrl, fullB64, mimeType, 'sent', null, false, msgId);

  // Setup TX Cancel UI
  const cancelPanel = document.getElementById('cancelPanel');
  const cancelText  = document.getElementById('cancelText');
  const cancelBtn   = document.getElementById('cancelTxBtn');

  cancelImgTx = false;
  cancelBtn.onclick = () => { cancelImgTx = true; };
  cancelPanel.style.display = 'flex';

  addSysMsg('📡 Transmitting "' + file.name + '" in ' + totalChunks + ' packets...');

  // ── Send START ─────────────────────────────────────────────
  await writeSerial('IMG:START:' + file.name + ':' + totalChunks + ':' + msgId);
  await delay(200);

  // ── Send DATA chunks ───────────────────────────────────────
  for (let i = 0; i < totalChunks; i++) {
    if (cancelImgTx) {
      await writeSerial('IMG:CANCEL:' + file.name);
      addSysMsg('🚫 Image transfer cancelled.');
      cancelPanel.style.display = 'none';
      return;
    }

    cancelText.textContent = `Sending... ${Math.round((i / totalChunks) * 100)}%`;

    const chunk = fullB64.slice(i * IMG_CHUNK_RAW_BYTES, (i + 1) * IMG_CHUNK_RAW_BYTES);
    const pkt   = 'IMG:DATA:' + file.name + ':' + i + ':' + chunk;

    if (pkt.length > 234) {
      addSysMsg('❌ Chunk ' + i + ' too long (' + pkt.length + ' bytes). Aborting.');
      cancelPanel.style.display = 'none';
      return;
    }

    let txWaitPromise = new Promise((resolve) => { resolveTxAwait = resolve; });
    await writeSerial(pkt);
    addDebug('→ IMG chunk ' + i + '/' + (totalChunks - 1) + ' sent (' + chunk.length + ' chars)');

    await Promise.race([txWaitPromise, delay(3000)]);
    resolveTxAwait = null;
  }

  cancelPanel.style.display = 'none';

  // ── Send END ───────────────────────────────────────────────
  await writeSerial('IMG:END:' + file.name);
  addSysMsg('✅ Image "' + file.name + '" sent in ' + totalChunks + ' packets!');
}

// ─── Write one line to the serial port ───────────────────────
async function writeSerial(text) {
  if (!outputStream) return;
  try {
    const writer = outputStream.getWriter();
    await writer.write(text + '\n');
    writer.releaseLock();
    addDebug('→ ' + text);
  } catch (e) {
    addSysMsg('❌ Send error: ' + e.message);
  }
}

// ─── Utility helpers ──────────────────────────────────────────
function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

function detectMime(b64) {
  if (b64.startsWith('/9j/'))    return 'image/jpeg';
  if (b64.startsWith('iVBORw')) return 'image/png';
  if (b64.startsWith('R0lGOD')) return 'image/gif';
  if (b64.startsWith('UklGR'))  return 'image/webp';
  if (b64.startsWith('Qk'))     return 'image/bmp';
  return 'image/bmp';
}

function base64ToBlobUrl(b64, mimeType) {
  try {
    const byteChars  = atob(b64);
    const byteArrays = [];
    for (let offset = 0; offset < byteChars.length; offset += 512) {
      const slice = byteChars.slice(offset, offset + 512);
      const ba    = new Uint8Array(slice.length);
      for (let i = 0; i < slice.length; i++) ba[i] = slice.charCodeAt(i);
      byteArrays.push(ba);
    }
    const blob = new Blob(byteArrays, { type: mimeType });
    return URL.createObjectURL(blob);
  } catch (e) {
    // fallback to data URL if atob fails
    return 'data:' + mimeType + ';base64,' + b64;
  }
}

function formatFileSize(b64Len) {
  // Approximate original byte size from base64 length
  const bytes = Math.round(b64Len * 0.75);
  if (bytes < 1024)       return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ─── UI Helpers ───────────────────────────────────────────────
function setConnected(connected) {
  statusDot.className    = 'status-dot ' + (connected ? 'connected' : 'disconnected');
  statusText.textContent = connected ? 'Connected' : 'Not Connected';
  connectBtn.classList.toggle('hidden', connected);
  disconnectBtn.classList.toggle('hidden', !connected);
  msgInput.disabled = !connected;
  sendBtn.disabled  = !connected;
  imgBtn.disabled   = !connected;
  if (!connected) contactStatus.textContent = 'Connect your board to start';
}

function removeWelcome() {
  const w = chatMessages.querySelector('.welcome-msg');
  if (w) w.remove();
}

function addBubble(sender, text, direction, msgTime = null, noSave = false, msgId = null) {
  removeWelcome();
  if (!msgId) msgId = mkId();

  const wrapper = document.createElement('div');
  wrapper.className = 'msg-wrapper ' + direction;
  wrapper.dataset.id = msgId;

  const senderEl = document.createElement('div');
  senderEl.className = 'msg-sender';
  senderEl.textContent = sender;

  const delBtn = document.createElement('button');
  delBtn.className = 'del-btn';
  delBtn.textContent = '🗑️';
  delBtn.title = direction === 'sent' ? 'Delete for everyone' : 'Delete for me';
  delBtn.onclick = async () => {
    deleteMessageById(msgId);
    if (direction === 'sent') await writeSerial('CMD:DEL:' + msgId);
  };
  senderEl.appendChild(delBtn);

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = text;

  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = msgTime || now();

  wrapper.appendChild(senderEl);
  wrapper.appendChild(bubble);
  wrapper.appendChild(time);
  chatMessages.appendChild(wrapper);
  scrollBottom();

  if (!noSave) {
    saveChatHistory({ id: msgId, type: 'text', sender, text, direction, time: time.textContent });
  }
}

// ─── WhatsApp-style image bubble ─────────────────────────────
function addImageBubble(sender, filename, blobUrl, rawB64, mimeType, direction, msgTime = null, noSave = false, msgId = null) {
  removeWelcome();
  if (!msgId) msgId = mkId();

  const wrapper = document.createElement('div');
  wrapper.className = 'msg-wrapper ' + direction;
  wrapper.dataset.id = msgId;

  // ── Sender row ─────────────────────────────────────────────
  const senderEl = document.createElement('div');
  senderEl.className = 'msg-sender';
  senderEl.textContent = sender;

  const delBtn = document.createElement('button');
  delBtn.className = 'del-btn';
  delBtn.textContent = '🗑️';
  delBtn.title = direction === 'sent' ? 'Delete for everyone' : 'Delete for me';
  delBtn.onclick = async () => {
    deleteMessageById(msgId);
    if (direction === 'sent') await writeSerial('CMD:DEL:' + msgId);
  };
  senderEl.appendChild(delBtn);

  // ── Image card bubble ──────────────────────────────────────
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble img-bubble';

  // Image container (click → lightbox)
  const imgContainer = document.createElement('div');
  imgContainer.className = 'wa-img-container';

  const img = document.createElement('img');
  img.src       = blobUrl;
  img.className = 'wa-chat-img';
  img.alt       = filename;
  img.title     = 'Tap to view';
  img.addEventListener('click', () => openLightbox(blobUrl, filename));

  // Loading spinner overlay (hides when image loads)
  const spinner = document.createElement('div');
  spinner.className = 'wa-img-spinner';
  spinner.innerHTML = '<div class="spinner-ring"></div>';
  img.addEventListener('load', () => { spinner.style.display = 'none'; });
  img.addEventListener('error', () => { spinner.innerHTML = '⚠️'; });

  imgContainer.appendChild(img);
  imgContainer.appendChild(spinner);

  // ── Footer row: filename + size + download ─────────────────
  const footer = document.createElement('div');
  footer.className = 'wa-img-footer';

  const fileInfo = document.createElement('div');
  fileInfo.className = 'wa-img-fileinfo';

  const fileIcon = document.createElement('span');
  fileIcon.className = 'wa-file-icon';
  fileIcon.textContent = '🖼';

  const fileNameEl = document.createElement('span');
  fileNameEl.className = 'wa-file-name';
  fileNameEl.textContent = filename;

  const fileSizeEl = document.createElement('span');
  fileSizeEl.className = 'wa-file-size';
  fileSizeEl.textContent = rawB64 ? formatFileSize(rawB64.length) : '';

  fileInfo.appendChild(fileIcon);
  fileInfo.appendChild(fileNameEl);
  fileInfo.appendChild(fileSizeEl);

  // Download button — downloads the actual image file
  const dlBtn = document.createElement('a');
  dlBtn.href     = blobUrl;
  dlBtn.download = filename;
  dlBtn.className = 'wa-download-btn';
  dlBtn.title    = 'Download image';
  dlBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
    <path d="M5 20h14v-2H5v2zm7-18l-7 7h4v6h6v-6h4l-7-7z" transform="rotate(180,12,12)"/>
    <path d="M19 9h-4V3H9v6H5l7 7 7-7z"/>
  </svg>`;
  dlBtn.addEventListener('click', (e) => e.stopPropagation());

  footer.appendChild(fileInfo);
  footer.appendChild(dlBtn);

  bubble.appendChild(imgContainer);
  bubble.appendChild(footer);

  // ── Time + tick ───────────────────────────────────────────
  const timeRow = document.createElement('div');
  timeRow.className = 'wa-img-time-row';

  const time = document.createElement('span');
  time.className = 'msg-time';
  time.textContent = msgTime || now();

  if (direction === 'sent') {
    const tick = document.createElement('span');
    tick.className = 'wa-tick';
    tick.innerHTML = `<svg viewBox="0 0 16 15" width="14" height="14" fill="none">
      <path d="M15.01 3.316l-.478-.372a.365.365 0 0 0-.51.063L8.666 9.88a.32.32 0 0 1-.484.033L5.68 7.167a.369.369 0 0 0-.525.006l-.39.422a.372.372 0 0 0 .006.525l3.33 3.065a.32.32 0 0 0 .485-.033l6.272-8.048a.366.366 0 0 0-.063-.51zm-4.134 0l-.478-.372a.365.365 0 0 0-.51.063L4.566 9.88a.32.32 0 0 1-.484.033L1.57 7.258a.369.369 0 0 0-.525.006l-.39.422a.372.372 0 0 0 .006.525l3.33 3.065a.32.32 0 0 0 .484-.033l6.273-8.048a.365.365 0 0 0-.063-.51z" fill="#53bdeb"/>
    </svg>`;
    timeRow.appendChild(time);
    timeRow.appendChild(tick);
  } else {
    timeRow.appendChild(time);
  }

  bubble.appendChild(timeRow);

  wrapper.appendChild(senderEl);
  wrapper.appendChild(bubble);
  chatMessages.appendChild(wrapper);
  scrollBottom();

  if (!noSave) {
    // Save base64 to localStorage for persistence (not blob URL which is session-only)
    saveChatHistory({ id: msgId, type: 'image', sender, filename, rawBase64: rawB64, mimeType, direction, time: time.textContent });
  }
}

function deleteMessageById(msgId) {
  const el = chatMessages.querySelector(`.msg-wrapper[data-id="${msgId}"]`);
  if (el) el.remove();
  chatHistory = chatHistory.filter(m => m.id !== msgId);
  localStorage.setItem('lora_chat_history', JSON.stringify(chatHistory));
}

function addSysMsg(text) {
  const el = document.createElement('div');
  el.className = 'sys-msg';
  el.textContent = text;
  chatMessages.appendChild(el);
  scrollBottom();
}

function addDebug(text) {
  const line = document.createElement('div');
  line.textContent = '[' + now() + '] ' + text;
  debugLog.appendChild(line);
  debugLog.scrollTop = debugLog.scrollHeight;
  while (debugLog.children.length > 60) {
    debugLog.removeChild(debugLog.firstChild);
  }
}

function scrollBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function now() {
  const d = new Date();
  return d.getHours().toString().padStart(2, '0') + ':' +
         d.getMinutes().toString().padStart(2, '0');
}

function saveChatHistory(msg) {
  chatHistory.push(msg);
  if (chatHistory.length > 50) chatHistory.shift();
  try {
    localStorage.setItem('lora_chat_history', JSON.stringify(chatHistory));
  } catch (e) {
    if (chatHistory.length > 0) {
      chatHistory.shift();
      saveChatHistory(msg);
    }
  }
}

function loadChatHistory() {
  chatHistory.forEach(msg => {
    if (msg.type === 'text') {
      addBubble(msg.sender, msg.text, msg.direction, msg.time, true, msg.id);
    } else if (msg.type === 'image') {
      // Restore image from saved base64
      const mime    = msg.mimeType || detectMime(msg.rawBase64 || '') || 'image/bmp';
      const blobUrl = msg.rawBase64 ? base64ToBlobUrl(msg.rawBase64, mime) : (msg.dataUrl || '');
      addImageBubble(msg.sender, msg.filename, blobUrl, msg.rawBase64 || '', mime, msg.direction, msg.time, true, msg.id);
    }
  });
}

// ─── Event Listeners ──────────────────────────────────────────
connectBtn.addEventListener('click', connectPort);
disconnectBtn.addEventListener('click', disconnectPort);

msgForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const txt = msgInput.value.trim();
  if (txt) {
    sendMessage(txt);
    msgInput.value = '';
  }
});

clearChatBtn.addEventListener('click', () => {
  chatMessages.innerHTML = '';
  chatHistory = [];
  localStorage.setItem('lora_chat_history', '[]');
  addSysMsg('🗑️ Chat cleared');
});

imgBtn.addEventListener('click', () => {
  if (imgBtn.disabled) return;
  imgFileInput.click();
});

imgFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) {
    await sendImage(file);
    imgFileInput.value = '';
  }
});

// Load history on boot
loadChatHistory();
