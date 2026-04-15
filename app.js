// ============================================================
//  LoRa Messenger – Web App (app.js)
//  Fixes:
//   • Baud-rate default raised to 115200 (matches firmware fix)
//   • Chunked BMP image transfer  (IMG: protocol)
//   • Image reassembly on receive with in-chat display
// ============================================================

// ─── State ───────────────────────────────────────────────────
let port, reader, outputStream;
let inputDone, outputDone, inputStream;
let txCount = 0;
let rxCount = 0;

let chatHistory = JSON.parse(localStorage.getItem('lora_chat_history') || '[]');

let cancelImgTx = false;
function mkId() { return Math.random().toString(36).substr(2,6); }

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

// ─── Image Transfer Constants ─────────────────────────────────
// LoRa max payload = 255 bytes
// NETWORK_ID = 20 bytes  → 235 bytes free per packet
// "IMG:DATA:0000:" = 14 bytes header
// Remaining for base64 payload: 220 chars → encodes ~165 bytes binary
const IMG_CHUNK_RAW_BYTES = 150;   // conservative – gives 200 base64 chars

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
    // Signals the image sender that the board finished transmitting
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

  // ── Image protocol ──────────────────────────────────────────
  if (payload.startsWith('IMG:CANCEL:')) {
    const fname = payload.slice('IMG:CANCEL:'.length);
    delete imgRxSessions[fname];
    addSysMsg('🚫 Image transfer "' + fname + '" was cancelled by sender.');
    return;
  }

  if (payload.startsWith('IMG:START:')) {
    // IMG:START:<filename>:<totalChunks>:<msgId>
    const parts  = payload.split(':');
    const fname  = parts[2] || 'image.bmp';
    const total  = parseInt(parts[3], 10);
    const msgId  = parts[4] || mkId(); // optional msgId
    imgRxSessions[fname] = { total, chunks: [], msgId };
    addSysMsg('📷 Receiving image "' + fname + '" (' + total + ' chunks)...');
    return;
  }

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

  if (payload.startsWith('IMG:END:')) {
    // IMG:END:<filename>
    const fname   = payload.slice('IMG:END:'.length);
    const session = imgRxSessions[fname];
    if (!session) return;

    const allB64 = session.chunks.join('');
    
    // Check if any chunks were lost over the radio
    let missing = 0;
    for (let i = 0; i < session.total; i++) {
       if (!session.chunks[i]) missing++;
    }
    
    if (missing > 0) {
       addSysMsg('⚠️ Image "' + fname + '" has ' + missing + ' missing chunks. The file might be corrupted.');
    }

    // Auto-detect image type from base64 signature
    let mimeType = 'image/bmp';
    if (allB64.startsWith('/9j/')) mimeType = 'image/jpeg';
    else if (allB64.startsWith('iVBORw')) mimeType = 'image/png';
    else if (allB64.startsWith('R0lGOD')) mimeType = 'image/gif';
    else if (allB64.startsWith('UklGR')) mimeType = 'image/webp';
    else if (allB64.startsWith('Qk')) mimeType = 'image/bmp';

    // Convert base64 string → data URL and display in chat
    const dataUrl = 'data:' + mimeType + ';base64,' + allB64;
    addImageBubble('Remote', fname, dataUrl, allB64, 'received', null, false, session.msgId);
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

  // Legacy fallback text message processing
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

  // Hard guard: LoRa packet limit
  if (payload.length > 234) {
    addSysMsg('⚠️ Message too long! Max ~200 characters.');
    return;
  }

  addBubble('You', text.trim(), 'sent', null, false, msgId);
  await writeSerial(payload);
}

// ─── Send an Image file over LoRa (chunked) ──────────────
async function sendImage(file) {
  if (!outputStream) return;
  if (!file.type.startsWith('image/')) {
    addSysMsg('⚠️ Please upload a valid image file (JPG, PNG, BMP, etc).');
    return;
  }

  addSysMsg('📷 Reading image "' + file.name + '"...');

  const arrayBuf = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuf);
  
  // Convert raw bytes → base64 in one go
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const fullB64 = btoa(binary);

  const totalBytes = fullB64.length;
  const totalChunks = Math.ceil(totalBytes / IMG_CHUNK_RAW_BYTES);

  // Auto-detect image type from base64 signature to show local preview perfectly
  let prevMime = 'image/bmp';
  if (fullB64.startsWith('/9j/')) prevMime = 'image/jpeg';
  else if (fullB64.startsWith('iVBORw')) prevMime = 'image/png';
  else if (fullB64.startsWith('R0lGOD')) prevMime = 'image/gif';
  else if (fullB64.startsWith('UklGR')) prevMime = 'image/webp';
  else if (fullB64.startsWith('Qk')) prevMime = 'image/bmp';

  // Generate ID
  const msgId = mkId();

  // Show preview locally
  const dataUrlPreview = 'data:' + prevMime + ';base64,' + fullB64;
  addImageBubble('You', file.name, dataUrlPreview, fullB64, 'sent', null, false, msgId);

  // Setup TX Cancel UI
  const cancelPanel = document.getElementById('cancelPanel');
  const cancelText = document.getElementById('cancelText');
  const cancelBtn = document.getElementById('cancelTxBtn');
  
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
    
    cancelText.textContent = `Sending... ${Math.round((i/totalChunks)*100)}%`;

    const chunk = fullB64.slice(i * IMG_CHUNK_RAW_BYTES, (i + 1) * IMG_CHUNK_RAW_BYTES);
    const pkt   = 'IMG:DATA:' + file.name + ':' + i + ':' + chunk;

    if (pkt.length > 234) {
      addSysMsg('❌ Chunk ' + i + ' too long (' + pkt.length + ' bytes). Aborting.');
      cancelPanel.style.display = 'none';
      return;
    }

    // Set up a promise to wait for the exact moment the board finishes LoRa TX
    let txWaitPromise = new Promise((resolve) => {
      resolveTxAwait = resolve;
    });

    await writeSerial(pkt);
    addDebug('→ IMG chunk ' + i + '/' + (totalChunks - 1) + ' sent (' + chunk.length + ' chars)');

    // Smart logic: Wait for the board to say TX_OK: before sending the next one!
    await Promise.race([
      txWaitPromise,
      delay(3000)
    ]);
    
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

// ─── Utility ──────────────────────────────────────────────────
function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
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

function addImageBubble(sender, filename, dataUrl, rawB64, direction, msgTime = null, noSave = false, msgId = null) {
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
  bubble.className = 'msg-bubble img-bubble';

  const caption = document.createElement('div');
  caption.className = 'img-caption';
  caption.textContent = '🖼 ' + filename;

  const img = document.createElement('img');
  img.src = dataUrl;
  img.className = 'chat-img';
  img.alt = filename;
  img.title = filename;

  const downloadBtn = document.createElement('a');
  
  // Provide ONLY the raw base64 as a .txt file download as requested
  const plainTextUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(rawB64);
  downloadBtn.href = plainTextUrl;
  
  // Force .txt extension for the download
  let dlName = filename;
  if (dlName.includes('.')) {
    dlName = dlName.substring(0, dlName.lastIndexOf('.'));
  }
  dlName += '_base64.txt';
  
  downloadBtn.download = dlName;
  
  downloadBtn.className = 'download-btn';
  downloadBtn.textContent = '💾 Download Raw Base64 (.txt)';

  bubble.appendChild(caption);
  bubble.appendChild(img);
  bubble.appendChild(downloadBtn);

  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = msgTime || now();

  wrapper.appendChild(senderEl);
  wrapper.appendChild(bubble);
  wrapper.appendChild(time);
  chatMessages.appendChild(wrapper);
  scrollBottom();
  
  if (!noSave) {
    saveChatHistory({ id: msgId, type: 'image', sender, filename, dataUrl, rawBase64: rawB64, direction, time: time.textContent });
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
         d.getMinutes().toString().padStart(2, '0') + ':' +
         d.getSeconds().toString().padStart(2, '0');
}

function saveChatHistory(msg) {
  chatHistory.push(msg);
  if (chatHistory.length > 50) chatHistory.shift(); // Keep last 50
  try {
    localStorage.setItem('lora_chat_history', JSON.stringify(chatHistory));
  } catch(e) {
    if(chatHistory.length > 0) {
      chatHistory.shift(); // Evict one more
      saveChatHistory(msg);
    }
  }
}

function loadChatHistory() {
  chatHistory.forEach(msg => {
    if (msg.type === 'text') {
      addBubble(msg.sender, msg.text, msg.direction, msg.time, true, msg.id);
    } else if (msg.type === 'image') {
      addImageBubble(msg.sender, msg.filename, msg.dataUrl, msg.rawBase64, msg.direction, msg.time, true, msg.id);
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

// Image button triggers hidden file input
imgBtn.addEventListener('click', () => {
  if (imgBtn.disabled) return;
  imgFileInput.click();
});

imgFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) {
    await sendImage(file);
    // Reset so the same file can be sent again
    imgFileInput.value = '';
  }
});

// Load history on boot
loadChatHistory();
