// ─── State ───────────────────────────────────────────────────
let port, reader, outputStream;
let inputDone, outputDone, inputStream;
let txCount = 0;
let rxCount = 0;

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

    // Setup text streams
    const encoder = new TextEncoderStream();
    outputDone = encoder.readable.pipeTo(port.writable);
    outputStream = encoder.writable;

    const decoder = new TextDecoderStream();
    inputDone = port.readable.pipeTo(decoder.writable);
    inputStream = decoder.readable;

    // Update UI
    setConnected(true);
    addSysMsg('🔌 Board connected at ' + baud + ' baud');

    // Start reading incoming data
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
    if (outputStream) { const w = outputStream.getWriter(); await w.close().catch(() => {}); w.releaseLock(); }
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
    // Incoming LoRa message from another board
    const raw = line.slice(3);
    rxCount++;
    rxCountEl.textContent = rxCount;

    // Try to parse "Name: Message" format
    const colonIdx = raw.indexOf(':');
    let sender = 'Remote';
    let text = raw;
    if (colonIdx > 0 && colonIdx < 20) {
      sender = raw.slice(0, colonIdx).trim();
      text   = raw.slice(colonIdx + 1).trim();
    }

    addBubble(sender, text, 'received');

  } else if (line.startsWith('TX_OK:')) {
    // Our message was transmitted
    txCount++;
    txCountEl.textContent = txCount;

  } else if (line.startsWith('TX_ERR:')) {
    addSysMsg('⚠️ Transmit error: ' + line.slice(7));

  } else if (line.startsWith('ERR:')) {
    addSysMsg('❌ Radio error code: ' + line.slice(4));
  }
}

// ─── Send Message ─────────────────────────────────────────────
async function sendMessage(text) {
  if (!outputStream || !text.trim()) return;

  const name = myNameInput.value.trim() || 'Me';
  const payload = name + ': ' + text.trim();

  // Show in our own chat
  addBubble('You', text.trim(), 'sent');

  // Write to serial (board will transmit via LoRa)
  try {
    const writer = outputStream.getWriter();
    await writer.write(payload + '\n');
    writer.releaseLock();
    addDebug('→ ' + payload);
  } catch (e) {
    addSysMsg('❌ Send error: ' + e.message);
  }
}

// ─── UI Helpers ───────────────────────────────────────────────
function setConnected(connected) {
  statusDot.className   = 'status-dot ' + (connected ? 'connected' : 'disconnected');
  statusText.textContent = connected ? 'Connected' : 'Not Connected';
  connectBtn.classList.toggle('hidden', connected);
  disconnectBtn.classList.toggle('hidden', !connected);
  msgInput.disabled  = !connected;
  sendBtn.disabled   = !connected;
  if (!connected) contactStatus.textContent = 'Connect your board to start';
}

function addBubble(sender, text, direction) {
  // Remove welcome screen on first message
  const welcome = chatMessages.querySelector('.welcome-msg');
  if (welcome) welcome.remove();

  const wrapper = document.createElement('div');
  wrapper.className = 'msg-wrapper ' + direction;

  const senderEl = document.createElement('div');
  senderEl.className = 'msg-sender';
  senderEl.textContent = sender;

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = text;

  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = now();

  wrapper.appendChild(senderEl);
  wrapper.appendChild(bubble);
  wrapper.appendChild(time);
  chatMessages.appendChild(wrapper);
  scrollBottom();
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
  // Keep max 60 lines in debug
  while (debugLog.children.length > 60) {
    debugLog.removeChild(debugLog.firstChild);
  }
}

function scrollBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function now() {
  const d = new Date();
  return d.getHours().toString().padStart(2,'0') + ':' +
         d.getMinutes().toString().padStart(2,'0') + ':' +
         d.getSeconds().toString().padStart(2,'0');
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
  addSysMsg('🗑️ Chat cleared');
});
