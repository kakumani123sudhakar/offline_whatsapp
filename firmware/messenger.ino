#include <RadioLib.h>

// --- RF Switch Definition for LoRa-E5 Mini ---
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

volatile bool receivedFlag = false;
void setFlag(void) {
  receivedFlag = true;
}

// ==========================================
// 🔒 GROUP NETWORK ID (Secret Channel)
// Change this to anything you want! 
// Only boards with this EXACT text can see each other's messages.
String NETWORK_ID = "[MY_SECRET_GROUP_1]"; 
// ==========================================

void setup() {
  Serial.setTx(PB6);
  Serial.setRx(PB7);
  Serial.begin(9600);
  Serial.setTimeout(50); 
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
  state = radio.startReceive();
}

void loop() {
  // ------------------------------------------
  // 1. RECEIVING MESSAGES
  // ------------------------------------------
  if (receivedFlag) {
    receivedFlag = false;
    
    String incomingMsg;
    int state = radio.readData(incomingMsg);
    
    if (state == RADIOLIB_ERR_NONE) {
      // 🔒 Check if the message belongs to our group
      if (incomingMsg.startsWith(NETWORK_ID)) {
        // Remove the secret ID text so the website only sees the beautiful message
        incomingMsg = incomingMsg.substring(NETWORK_ID.length());
        
        Serial.print("RX:");
        Serial.println(incomingMsg);
      }
      // If it doesn't match the NETWORK_ID, we completely ignore it!
    } 
    
    radio.startReceive();
  }

  // ------------------------------------------
  // 2. TRANSMITTING MESSAGES
  // ------------------------------------------
  if (Serial.available() > 0) {
    String msgToEn = Serial.readStringUntil('\n');
    msgToEn.trim(); 
    
    if (msgToEn.length() > 0) {
      
      // 🔒 Prepend our secure Network ID to the radio wave
      String finalTransmission = NETWORK_ID + msgToEn;
      
      int state = radio.transmit(finalTransmission);
      
      if (state == RADIOLIB_ERR_NONE) {
        Serial.println("TX_OK:"); 
      } else {
        Serial.print("TX_ERR:");
        Serial.println(state);
      }
      
      // FIX FOR THE GHOST ECHO
      receivedFlag = false; 
      
      radio.startReceive();
    }
  }
}
