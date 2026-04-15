// ============================================================
//  LoRa Messenger Firmware  –  STM32 LoRa-E5 Mini
//  Fixes:  1) Serial buffer overrun (char-by-char reader)
//          2) Chunked BMP image transfer protocol
// ============================================================

#include <RadioLib.h>

// ─── RF Switch ───────────────────────────────────────────────
static const uint32_t rfswitch_pins[] = {
  PA4, PA5, RADIOLIB_NC, RADIOLIB_NC, RADIOLIB_NC
};
static const Module::RfSwitchMode_t rfswitch_table[] = {
  {STM32WLx::MODE_IDLE,  {LOW,  LOW }},
  {STM32WLx::MODE_RX,    {HIGH, LOW }},
  {STM32WLx::MODE_TX_LP, {LOW,  HIGH}},
  {STM32WLx::MODE_TX_HP, {LOW,  HIGH}},
  END_OF_MODE_TABLE,
};

STM32WLx radio = new STM32WLx_Module();

// ─── Receive flag (ISR-safe) ─────────────────────────────────
volatile bool receivedFlag = false;
void setFlag(void) { receivedFlag = true; }

// ─── Group Network ID ─────────────────────────────────────────
// Only boards with this EXACT text see each other's messages.
const String NETWORK_ID = "[MY_SECRET_GROUP_1]";   // 20 bytes

// ─── Serial RX buffer  (FIX: prevents buffer overrun) ────────
// STM32 default serial buffer is only 64 bytes. We read
// character-by-character into this large buffer ourselves.
#define SERIAL_BUF_SIZE 512
char serialBuf[SERIAL_BUF_SIZE];
int  serialBufLen = 0;

// ─── LoRa packet size limit ───────────────────────────────────
// LoRa SX126x hard limit = 255 bytes.
// NETWORK_ID takes 20 bytes → 235 bytes available per packet.
#define LORA_MAX_PAYLOAD 255
#define MSG_MAX  (LORA_MAX_PAYLOAD - (int)NETWORK_ID.length() - 1)
// MSG_MAX ≈ 234  (leave 1 byte safety margin)

// ─── Transmit helper ─────────────────────────────────────────
void transmitLine(const String& line) {
  String packet = NETWORK_ID + line;

  if ((int)packet.length() > LORA_MAX_PAYLOAD) {
    Serial.println("TX_ERR:TOO_LONG");
    return;
  }

  int state = radio.transmit(packet);
  receivedFlag = false;          // clear ghost-echo

  if (state == RADIOLIB_ERR_NONE) {
    Serial.println("TX_OK:");
  } else {
    Serial.print("TX_ERR:");
    Serial.println(state);
  }
  radio.startReceive();
}

// ─── Process one complete line received from USB serial ───────
void processSerialLine(const String& line) {
  if (line.length() == 0) return;

  // All lines — text messages AND image protocol lines — are
  // forwarded over LoRa unchanged.  The chunking is done by the
  // web app so every line already fits inside MSG_MAX.
  transmitLine(line);
}

// ─── Setup ───────────────────────────────────────────────────
void setup() {
  Serial.setTx(PB6);
  Serial.setRx(PB7);
  // 115200 baud – reduces per-byte time to ~87µs so the STM32's
  // hardware FIFO never overflows even for long image chunks.
  Serial.begin(115200);
  delay(1000);

  radio.setRfSwitchTable(rfswitch_pins, rfswitch_table);

  int state = radio.begin(868.0);
  radio.setBandwidth(125.0);
  radio.setSpreadingFactor(9);
  radio.setCodingRate(7);
  radio.setOutputPower(14);

  if (state == RADIOLIB_ERR_NONE) {
    Serial.println("READY");
  } else {
    Serial.print("ERR:");
    Serial.println(state);
    while (true);
  }

  radio.setPacketReceivedAction(setFlag);
  radio.startReceive();
}

// ─── Main Loop ───────────────────────────────────────────────
void loop() {

  // ── 1. RECEIVE from LoRa ──────────────────────────────────
  if (receivedFlag) {
    receivedFlag = false;

    String incomingMsg;
    int state = radio.readData(incomingMsg);

    if (state == RADIOLIB_ERR_NONE) {
      if (incomingMsg.startsWith(NETWORK_ID)) {
        // Strip network prefix before forwarding to USB serial
        incomingMsg = incomingMsg.substring(NETWORK_ID.length());
        Serial.print("RX:");
        Serial.println(incomingMsg);
      }
      // Messages from other groups are silently ignored.
    }
    radio.startReceive();
  }

  // ── 2. TRANSMIT – read USB serial char-by-char ───────────
  // This replaces Serial.readStringUntil() which caused the
  // buffer overrun: the hardware FIFO would fill up and lose
  // bytes before the 50ms timeout expired.
  while (Serial.available() > 0) {
    char c = (char)Serial.read();

    if (c == '\n') {
      // End of line → process whatever we have collected
      if (serialBufLen > 0) {
        serialBuf[serialBufLen] = '\0';
        String line(serialBuf);
        // Remove trailing \r if present (Windows line endings)
        line.trim();
        serialBufLen = 0;
        if (line.length() > 0) {
          processSerialLine(line);
        }
      }
    } else if (c != '\r') {
      // Store the character; ignore \r
      if (serialBufLen < SERIAL_BUF_SIZE - 1) {
        serialBuf[serialBufLen++] = c;
      }
      // If buffer is completely full we silently drop extra bytes
      // instead of overrunning memory – the web app never sends
      // lines longer than MSG_MAX so this is a safety net only.
    }
  }
}
