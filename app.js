let port;
let reader;
let inputDone;
let outputDone;
let inputStream;
let outputStream;

const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const baudRateSelect = document.getElementById('baudRate');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const terminalOutput = document.getElementById('terminalOutput');
const messageForm = document.getElementById('messageForm');
const commandInput = document.getElementById('commandInput');
const clearBtn = document.getElementById('clearBtn');
const cmdBtns = document.querySelectorAll('.cmd-btn');

// Ensure Web Serial API is supported
if (!('serial' in navigator)) {
    appendMessage('System', 'Web Serial API not supported in your browser. Please use Chrome or Edge.', 'system');
    connectBtn.disabled = true;
}

// Connect to Serial Port
async function connectToPort() {
    try {
        // Request a port and open a connection
        port = await navigator.serial.requestPort();
        const baudRate = parseInt(baudRateSelect.value, 10);
        await port.open({ baudRate });

        setupStream();

        statusDot.className = 'dot connected';
        statusText.textContent = 'Connected';
        connectBtn.classList.add('hidden');
        disconnectBtn.classList.remove('hidden');

        appendMessage('System', `Connected to LoRa module at ${baudRate} baud.`, 'system');

        // Start the read loop
        readLoop();
    } catch (error) {
        appendMessage('System', `Error connecting: ${error.message}`, 'system');
        console.error(error);
    }
}

// Disconnect from Serial Port
async function disconnectFromPort() {
    if (reader) {
        await reader.cancel();
    }
    if (inputDone) {
        await inputDone.catch(() => {});
    }
    if (outputStream) {
        await outputStream.getWriter().close();
    }
    if (outputDone) {
        await outputDone.catch(() => {});
    }
    if (port) {
        await port.close();
        port = null;
    }

    statusDot.className = 'dot disconnected';
    statusText.textContent = 'Disconnected';
    connectBtn.classList.remove('hidden');
    disconnectBtn.classList.add('hidden');
    appendMessage('System', 'Disconnected from module.', 'system');
}

// Setup the Streams for text encoding/decoding
function setupStream() {
    const encoder = new TextEncoderStream();
    outputDone = encoder.readable.pipeTo(port.writable);
    outputStream = encoder.writable;

    const decoder = new TextDecoderStream();
    inputDone = port.readable.pipeTo(decoder.writable);
    inputStream = decoder.readable;
}

// Read loop to handle incoming data continuously
async function readLoop() {
    reader = inputStream.getReader();
    let buffer = '';

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) {
                break;
            }
            if (value) {
                buffer += value;
                // Parse lines by newline character for standard AT command responses
                let newlineIdx;
                while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
                    let line = buffer.slice(0, newlineIdx).replace('\r', '').trim();
                    if (line) {
                        appendMessage('RX', line, 'rx');
                    }
                    buffer = buffer.slice(newlineIdx + 1);
                }
            }
        }
    } catch (error) {
        console.error('Read error:', error);
    } finally {
        reader.releaseLock();
    }
}

// Write to the Serial Port
async function writeToStream(...lines) {
    if (!outputStream) {
        appendMessage('System', 'Error: Not connected to a device.', 'system');
        return;
    }

    const writer = outputStream.getWriter();
    for (const line of lines) {
        // STM32 LoRa-E5 requires \r\n (CRLF) for AT commands
        await writer.write(line + '\r\n');
        appendMessage('TX', line, 'tx');
    }
    writer.releaseLock();
}

// Append messages to the terminal UI
function appendMessage(source, text, type) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${type}`;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'time';
    const now = new Date();
    timeSpan.textContent = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

    const textNode = document.createTextNode(text);

    msgDiv.appendChild(timeSpan);
    msgDiv.appendChild(textNode);
    terminalOutput.appendChild(msgDiv);

    // Auto-scroll to bottom
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

// Event Listeners
connectBtn.addEventListener('click', connectToPort);
disconnectBtn.addEventListener('click', disconnectFromPort);

messageForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const cmd = commandInput.value.trim();
    if (cmd) {
        writeToStream(cmd);
        commandInput.value = '';
    }
});

clearBtn.addEventListener('click', () => {
    terminalOutput.innerHTML = '';
    appendMessage('System', 'Log cleared.', 'system');
});

// Quick command buttons
cmdBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const cmd = btn.getAttribute('data-cmd');
        if (cmd) {
            writeToStream(cmd);
        }
    });
});
