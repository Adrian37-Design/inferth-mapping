#include "CAN_OBD.h"

// ============================================================================
// UNIVERSAL AUTOMOTIVE CAN & OBD-II MULTI-VEHICLE ENGINE
// Pinned to ESP32-S3 Hardware TWAI Controller (CAN_TX=41, CAN_RX=42)
//
// Capabilities:
// 1. Auto-Baud Rate Detection (500k -> 250k -> 125k) in non-intrusive listen mode
// 2. Auto-Make Fingerprinting (Honda, Toyota, Nissan, VAG, Ford, Generic OBD)
// 3. Dual-Addressing OBD-II (11-bit 0x7DF and 29-bit 0x18DB33F1)
// 4. Dynamic Supported-PID Discovery (PIDs 0x00 & 0x20 bitmask auto-adaptation)
// 5. Zero-reflash vehicle swap: automatically adapts when plugged into any car
// ============================================================================

VehicleTelemetry car;
portMUX_TYPE canDataMux = portMUX_INITIALIZER_UNLOCKED;

// Supported OBD PIDs sequence for round-robin query
static const uint8_t CORE_OBD_PIDS[] = {
  PID_SUPPORTED_PIDS_01_20, // Initial discovery
  PID_ENGINE_LOAD,
  PID_COOLANT_TEMP,
  PID_ENGINE_RPM,
  PID_VEHICLE_SPEED,
  PID_MAP_KPA,
  PID_TIMING_ADVANCE,
  PID_INTAKE_TEMP,
  PID_MAF_AIRFLOW,
  PID_THROTTLE_POS,
  PID_RUNTIME_SEC,
  PID_FUEL_LEVEL_OBD,
  PID_ECU_VOLTAGE,
  PID_REL_THROTTLE,
  PID_SUPPORTED_PIDS_21_40
};
static const uint8_t TOTAL_CORE_OBD_PIDS = sizeof(CORE_OBD_PIDS) / sizeof(CORE_OBD_PIDS[0]);

static uint8_t currentObdPidIdx = 0;
static uint32_t lastObdQueryMs = 0;
static uint32_t lastDtcQueryMs = 0;
static uint32_t lastBusRecoveryCheckMs = 0;
static TaskHandle_t canTaskHandle = NULL;

// Multi-make signature frame occurrence counters (for passive auto-detection)
static uint16_t sig_honda_count = 0;
static uint16_t sig_toyota_count = 0;
static uint16_t sig_nissan_count = 0;
static uint16_t sig_vag_count = 0;
static uint16_t sig_ford_count = 0;
static uint32_t detectionStartMs = 0;

// Forward declarations
static bool testBaudRate(twai_timing_config_t t_config, uint16_t baud);
static void detectVehicleMakeFromFrame(uint32_t id);
static void decodeHondaFrame(const twai_message_t& msg);
static void decodeToyotaFrame(const twai_message_t& msg);
static void decodeNissanFrame(const twai_message_t& msg);
static void decodeVagFrame(const twai_message_t& msg);
static void decodeFordFrame(const twai_message_t& msg);
static void decodeStandardOBDResponse(const twai_message_t& msg);

// ============================================================================
// 1. AUTO-BAUD RATE SCANNER & TWAI INSTALLATION
// Tests candidate baud rates in listen-only mode without disturbing the vehicle
// ============================================================================
static bool testBaudRate(twai_timing_config_t t_config, uint16_t baud) {
  twai_general_config_t g_config = TWAI_GENERAL_CONFIG_DEFAULT(CAN_TX_PIN, CAN_RX_PIN, TWAI_MODE_LISTEN_ONLY);
  g_config.rx_queue_len = 64;
  g_config.tx_queue_len = 0;

  twai_filter_config_t f_config = TWAI_FILTER_CONFIG_ACCEPT_ALL();

  if (twai_driver_install(&g_config, &t_config, &f_config) != ESP_OK) return false;
  if (twai_start() != ESP_OK) {
    twai_driver_uninstall();
    return false;
  }

  Serial.printf("[CAN] Testing %d kbps in Listen-Only mode...\n", baud);

  uint32_t start = millis();
  uint16_t validFrames = 0;
  twai_message_t dummy;

  // Listen for up to 900ms for active frames
  while (millis() - start < 900) {
    if (twai_receive(&dummy, pdMS_TO_TICKS(30)) == ESP_OK) {
      if (!dummy.rtr) {
        validFrames++;
        if (validFrames >= 3) break; // Valid bus traffic confirmed
      }
    }
  }

  twai_stop();
  twai_driver_uninstall();

  if (validFrames >= 3) {
    Serial.printf("[CAN] SUCCESS: Locked to %d kbps bus speed!\n", baud);
    return true;
  }
  return false;
}

bool initTWAI() {
  Serial.println("[CAN] Starting Universal Automotive TWAI CAN Engine...");

  CANBaudRate lockedBaud = BAUD_UNKNOWN;

  // 1. Try 500 kbps (Standard on ~85% of modern vehicles)
  if (testBaudRate(TWAI_TIMING_CONFIG_500KBITS(), 500)) {
    lockedBaud = BAUD_500K;
  }
  // 2. Try 250 kbps (Older Japanese, American, and heavy vehicles)
  else if (testBaudRate(TWAI_TIMING_CONFIG_250KBITS(), 250)) {
    lockedBaud = BAUD_250K;
  }
  // 3. Try 125 kbps (Interior / Low speed CAN)
  else if (testBaudRate(TWAI_TIMING_CONFIG_125KBITS(), 125)) {
    lockedBaud = BAUD_125K;
  }

  // If vehicle ignition was off during boot, default to 500k and listen
  if (lockedBaud == BAUD_UNKNOWN) {
    Serial.println("[CAN] Bus idle or ignition off. Defaulting to 500 kbps Normal Mode.");
    lockedBaud = BAUD_500K;
  }

  car.bus_baud_rate = (uint16_t)lockedBaud;

  // Re-install in NORMAL mode for active bidirectional OBD-II + sniffer operation
  twai_general_config_t g_config = TWAI_GENERAL_CONFIG_DEFAULT(CAN_TX_PIN, CAN_RX_PIN, TWAI_MODE_NORMAL);
  g_config.rx_queue_len = 128;
  g_config.tx_queue_len = 16;

  twai_timing_config_t t_config = (lockedBaud == BAUD_250K) ? TWAI_TIMING_CONFIG_250KBITS() :
                                  ((lockedBaud == BAUD_125K) ? TWAI_TIMING_CONFIG_125KBITS() :
                                   TWAI_TIMING_CONFIG_500KBITS());

  twai_filter_config_t f_config = TWAI_FILTER_CONFIG_ACCEPT_ALL();

  esp_err_t err = twai_driver_install(&g_config, &t_config, &f_config);
  if (err != ESP_OK) {
    Serial.printf("[CAN] TWAI install failed: 0x%X\n", err);
    return false;
  }

  err = twai_start();
  if (err != ESP_OK) {
    Serial.printf("[CAN] TWAI start failed: 0x%X\n", err);
    return false;
  }

  detectionStartMs = millis();
  Serial.printf("[CAN] TWAI Controller Running at %d kbps (Normal Mode TX=41, RX=42)\n", car.bus_baud_rate);
  return true;
}

// ============================================================================
// 2. ACTIVE OBD-II TRANSMITTER (11-BIT 0x7DF & 29-BIT 0x18DB33F1)
// ============================================================================
bool sendOBDQuery(uint8_t pid) {
  twai_message_t query;
  query.rtr = 0;
  query.data_length_code = 8;
  query.data[0] = 0x02; // 2 payload bytes
  query.data[1] = 0x01; // Service 01: Powertrain live data
  query.data[2] = pid;  // PID
  query.data[3] = 0x55; // ISO-TP padding
  query.data[4] = 0x55;
  query.data[5] = 0x55;
  query.data[6] = 0x55;
  query.data[7] = 0x55;

  if (car.is_29bit_obd) {
    query.identifier = OBD_REQ_ID_29BIT;
    query.extd = 1;
  } else {
    query.identifier = OBD_REQ_ID_11BIT;
    query.extd = 0;
  }

  esp_err_t res = twai_transmit(&query, pdMS_TO_TICKS(15));
  if (res == ESP_OK) {
    car.tx_frame_count++;
    return true;
  }
  return false;
}

// Query Active Diagnostic Trouble Codes (Mode 03)
bool sendDTCQuery() {
  twai_message_t query;
  query.rtr = 0;
  query.data_length_code = 8;
  query.data[0] = 0x01;
  query.data[1] = 0x03; // Mode 03: Request emissions DTCs
  for (int i = 2; i < 8; i++) query.data[i] = 0x55;

  if (car.is_29bit_obd) {
    query.identifier = OBD_REQ_ID_29BIT;
    query.extd = 1;
  } else {
    query.identifier = OBD_REQ_ID_11BIT;
    query.extd = 0;
  }

  return (twai_transmit(&query, pdMS_TO_TICKS(15)) == ESP_OK);
}

// ============================================================================
// 3. VEHICLE MAKE AUTO-FINGERPRINTING SNIFFER
// Analyzes unique OEM broadcast IDs to automatically classify the vehicle make
// ============================================================================
static void detectVehicleMakeFromFrame(uint32_t id) {
  if (car.make_family != MAKE_DETECTING) return;

  // Honda signature IDs
  if (id == 0x17C || id == 0x164 || id == 0x1A4 || id == 0x21E || id == 0x405 || id == 0x324) {
    sig_honda_count++;
    if (sig_honda_count >= 5) {
      car.make_family = MAKE_HONDA;
      car.vehicle_make = "HONDA";
      Serial.println("[CAN-AUTO] Vehicle Make Identified: HONDA (F-CAN Architecture)");
    }
    return;
  }

  // Toyota / Lexus signature IDs
  if (id == 0x0B4 || id == 0x1C4 || id == 0x025 || id == 0x0B0 || id == 0x399 || id == 0x03B || id == 0x620) {
    sig_toyota_count++;
    if (sig_toyota_count >= 5) {
      car.make_family = MAKE_TOYOTA;
      car.vehicle_make = "TOYOTA";
      Serial.println("[CAN-AUTO] Vehicle Make Identified: TOYOTA/LEXUS (THS Architecture)");
    }
    return;
  }

  // Nissan / Infiniti signature IDs
  if (id == 0x180 || id == 0x280 || id == 0x421 || id == 0x354 || id == 0x60D) {
    sig_nissan_count++;
    if (sig_nissan_count >= 5) {
      car.make_family = MAKE_NISSAN;
      car.vehicle_make = "NISSAN";
      Serial.println("[CAN-AUTO] Vehicle Make Identified: NISSAN (CAN Architecture)");
    }
    return;
  }

  // VAG (Volkswagen / Audi / Skoda) signature IDs
  if (id == 0x280 || id == 0x380 || id == 0x440 || id == 0x086 || id == 0x470) {
    sig_vag_count++;
    if (sig_vag_count >= 5) {
      car.make_family = MAKE_VAG;
      car.vehicle_make = "VAG";
      Serial.println("[CAN-AUTO] Vehicle Make Identified: VAG (Volkswagen/Audi)");
    }
    return;
  }

  // Ford / Mazda signature IDs
  if (id == 0x201 || id == 0x430 || id == 0x433 || id == 0x4B0) {
    sig_ford_count++;
    if (sig_ford_count >= 5) {
      car.make_family = MAKE_FORD;
      car.vehicle_make = "FORD";
      Serial.println("[CAN-AUTO] Vehicle Make Identified: FORD/MAZDA (MS-CAN Architecture)");
    }
    return;
  }

  // If 10 seconds elapsed on active bus with no proprietary match, lock to Generic OBD-II
  if (millis() - detectionStartMs > 10000 && car.rx_frame_count > 50) {
    car.make_family = MAKE_GENERIC_OBD;
    car.vehicle_make = "GENERIC_OBD";
    Serial.println("[CAN-AUTO] No proprietary broadcast matched. Operating in Standard OBD-II Mode.");
  }
}

// ============================================================================
// 4. MULTI-MAKE OEM BROADCAST DECODERS
// ============================================================================

// --- HONDA / ACURA DECODER ---
static void decodeHondaFrame(const twai_message_t& msg) {
  switch (msg.identifier) {
    // 0x039: Airbag Crash
    case 0x039:
      if (msg.data_length_code >= 2) car.crash_detected = (msg.data[0] != 0x00 || (msg.data[1] & 0x01) != 0);
      break;

    // 0x13F: Accelerator Pedal
    case 0x13F:
      if (msg.data_length_code >= 2) car.pedal_pct = map(msg.data[1], 0, 255, 0, 100);
      break;

    // 0x143: Steering Wheel Angle
    case 0x143:
      if (msg.data_length_code >= 2) car.steering_angle_deg = (int16_t)((msg.data[0] << 8) | msg.data[1]) * 0.1f;
      break;

    // 0x161: 4 Wheel Speeds
    case 0x161:
      if (msg.data_length_code >= 8) {
        car.wheel_speed_fl = (((uint16_t)msg.data[0] << 8) | msg.data[1]) * 0.01f;
        car.wheel_speed_fr = (((uint16_t)msg.data[2] << 8) | msg.data[3]) * 0.01f;
        car.wheel_speed_rl = (((uint16_t)msg.data[4] << 8) | msg.data[5]) * 0.01f;
        car.wheel_speed_rr = (((uint16_t)msg.data[6] << 8) | msg.data[7]) * 0.01f;
      }
      break;

    // 0x164: Vehicle Speed & Gear
    case 0x164:
      if (msg.data_length_code >= 5) {
        car.speed = msg.data[3];
        uint8_t g = msg.data[4];
        if (g == 0xB1) car.gear = "P";
        else if (g == 0xB2) car.gear = "R";
        else if (g == 0xB3) car.gear = "N";
        else if (g == 0xB4 || g == 0x20) car.gear = "D";
      }
      break;

    // 0x17C: Engine RPM & Cranking
    case 0x17C:
      if (msg.data_length_code >= 4) {
        uint16_t r = ((uint16_t)msg.data[2] << 8) | msg.data[3];
        car.rpm = r;
        if (r > 350) car.ignition = true;
      }
      break;

    // 0x18E: VSA / Traction
    case 0x18E:
      if (msg.data_length_code >= 1) car.traction_loss = ((msg.data[0] & 0x02) != 0);
      break;

    // 0x191: IMA Hybrid Motor Assist / Regen kW
    case 0x191:
      if (msg.data_length_code >= 4) car.hybrid_motor_kw = ((int16_t)((msg.data[2] << 8) | msg.data[3])) / 10;
      break;

    // 0x1A4: Brake Pressure & ABS
    case 0x1A4:
      if (msg.data_length_code >= 4) {
        car.brake_pressed = ((msg.data[0] & 0x80) != 0);
        car.abs_active    = ((msg.data[0] & 0x08) != 0);
        car.brake_pressure_bar = (((msg.data[2] & 0x7F) << 8) | msg.data[3]) * 0.1f;
      }
      break;

    // 0x1AA: Yaw & Lateral G
    case 0x1AA:
      if (msg.data_length_code >= 4) {
        car.yaw_rate  = (int16_t)((msg.data[0] << 8) | msg.data[1]) * 0.05f;
        car.lateral_g = (int16_t)((msg.data[2] << 8) | msg.data[3]) * 0.005f;
      }
      break;

    // 0x1CF: Inverter IGBT Temp
    case 0x1CF:
      if (msg.data_length_code >= 3) car.inverter_temp_c = (int16_t)msg.data[2] - 40;
      break;

    // 0x1D0: Hybrid Auto Stop
    case 0x1D0:
      if (msg.data_length_code >= 2) car.hybrid_auto_stop = ((msg.data[1] & 0x08) != 0);
      break;

    // 0x21E: Hybrid Battery SoC %
    case 0x21E:
      if (msg.data_length_code >= 3) car.hybrid_soc_pct = msg.data[2] / 2;
      break;

    // 0x294: Hybrid Battery Pack Temp
    case 0x294:
      if (msg.data_length_code >= 4) car.batt_temp_c = (int16_t)msg.data[1] - 40;
      break;

    // 0x305: Key in Barrel & ACC
    case 0x305:
      if (msg.data_length_code >= 2) {
        car.key_in_barrel = ((msg.data[0] & 0x01) != 0);
        if ((msg.data[0] & 0x02) != 0) car.ignition = true;
      }
      break;

    // 0x320: CVT Fluid Temp
    case 0x320:
      if (msg.data_length_code >= 2) car.cvt_fluid_temp_c = (int16_t)msg.data[1] - 40;
      break;

    // 0x324: MIL & Handbrake
    case 0x324:
      if (msg.data_length_code >= 3) {
        car.check_engine_mil  = ((msg.data[0] & 0x40) != 0);
        car.handbrake_engaged = ((msg.data[1] & 0x04) != 0);
      }
      break;

    // 0x374: AC Compressor
    case 0x374:
      if (msg.data_length_code >= 2) car.ac_compressor_on = ((msg.data[1] & 0x04) != 0);
      break;

    // 0x378: Lights
    case 0x378:
      if (msg.data_length_code >= 3) {
        car.headlights_on      = ((msg.data[0] & 0x04) != 0);
        car.highbeam_on        = ((msg.data[0] & 0x08) != 0);
        car.turn_signal_active = ((msg.data[1] & 0x03) != 0);
        car.hazard_lights_on   = ((msg.data[1] & 0x04) != 0);
      }
      break;

    // 0x384: Fuel Level %
    case 0x384:
      if (msg.data_length_code >= 2) {
        car.fuel_pct = msg.data[1];
        car.low_fuel_warning = (car.fuel_pct <= 12.0f);
      }
      break;

    // 0x3D7: TPMS
    case 0x3D7:
      if (msg.data_length_code >= 2) car.tpms_warning = ((msg.data[1] & 0x80) != 0);
      break;

    // 0x405: Doors & Seatbelt
    case 0x405:
      if (msg.data_length_code >= 3) {
        car.seatbelt_unbuckled = ((msg.data[0] & 0x10) != 0);
        car.door_driver_open   = ((msg.data[1] & 0x01) != 0);
        car.door_pass_open     = ((msg.data[1] & 0x02) != 0);
        car.door_rear_open     = ((msg.data[1] & 0x04) != 0);
        car.trunk_open         = ((msg.data[1] & 0x08) != 0);
      }
      break;

    // 0x454: Immobilizer
    case 0x454:
      if (msg.data_length_code >= 2) car.immobilizer_auth = (msg.data[0] == 0x00);
      break;

    // 0x465: Oil Life
    case 0x465:
      if (msg.data_length_code >= 2) car.oil_life_pct = msg.data[1];
      break;

    // 0x6C1: Odometer pulses
    case 0x6C1:
      car.odometer_pulses++;
      break;

    default:
      break;
  }
}

// --- TOYOTA / LEXUS DECODER (Prius, Aqua, Corolla, Hilux, Prado, Camry) ---
static void decodeToyotaFrame(const twai_message_t& msg) {
  switch (msg.identifier) {
    // 0x020: Brake Switch & Master Cylinder Pressure
    case 0x020:
      if (msg.data_length_code >= 4) {
        car.brake_pressed = ((msg.data[0] & 0x01) != 0);
        car.abs_active    = ((msg.data[0] & 0x10) != 0);
        car.brake_pressure_bar = msg.data[1] * 0.5f;
      }
      break;

    // 0x025: Steering Wheel Angle
    case 0x025:
      if (msg.data_length_code >= 2) car.steering_angle_deg = (int16_t)((msg.data[0] << 8) | msg.data[1]) * 0.1f;
      break;

    // 0x03B: Hybrid Battery State of Charge (THS-II Prius/Aqua)
    case 0x03B:
      if (msg.data_length_code >= 3) {
        car.hybrid_soc_pct = msg.data[0] / 2; // 0-100%
        if (msg.data_length_code >= 5) {
          int16_t mkw = (int16_t)((msg.data[3] << 8) | msg.data[4]);
          car.hybrid_motor_kw = mkw / 10;
        }
      }
      break;

    // 0x0B0: Wheel Speeds Front
    case 0x0B0:
      if (msg.data_length_code >= 4) {
        car.wheel_speed_fl = (((uint16_t)msg.data[0] << 8) | msg.data[1]) * 0.01f;
        car.wheel_speed_fr = (((uint16_t)msg.data[2] << 8) | msg.data[3]) * 0.01f;
      }
      break;

    // 0x0B2: Wheel Speeds Rear
    case 0x0B2:
      if (msg.data_length_code >= 4) {
        car.wheel_speed_rl = (((uint16_t)msg.data[0] << 8) | msg.data[1]) * 0.01f;
        car.wheel_speed_rr = (((uint16_t)msg.data[2] << 8) | msg.data[3]) * 0.01f;
      }
      break;

    // 0x0B4: Vehicle Speed
    case 0x0B4:
      if (msg.data_length_code >= 7) {
        car.speed = (uint8_t)((((uint16_t)msg.data[5] << 8) | msg.data[6]) * 0.01f);
      }
      break;

    // 0x1C4: Engine RPM & Ignition
    case 0x1C4:
      if (msg.data_length_code >= 4) {
        uint16_t r = ((uint16_t)msg.data[0] << 8) | msg.data[1];
        car.rpm = r;
        if (r > 350) car.ignition = true;
      }
      break;

    // 0x224 / 0x399: Gear Selector
    case 0x224:
    case 0x399:
      if (msg.data_length_code >= 1) {
        uint8_t g = msg.data[0];
        if (g == 0x00 || g == 0x20) car.gear = "P";
        else if (g == 0x01 || g == 0x10) car.gear = "R";
        else if (g == 0x02 || g == 0x08) car.gear = "N";
        else if (g == 0x03 || g == 0x04) car.gear = "D";
        else if (g == 0x04 || g == 0x02) car.gear = "B";
      }
      break;

    // 0x245 / 0x260: Accelerator Pedal
    case 0x245:
    case 0x260:
      if (msg.data_length_code >= 1) car.pedal_pct = (uint8_t)(msg.data[0] / 2.55f);
      break;

    // 0x610: Fuel Level
    case 0x610:
      if (msg.data_length_code >= 3) {
        car.fuel_pct = msg.data[2] / 2.55f;
        car.low_fuel_warning = (car.fuel_pct <= 12.0f);
      }
      break;

    // 0x620: Doors Ajar & Seatbelt
    case 0x620:
      if (msg.data_length_code >= 6) {
        car.door_driver_open = ((msg.data[5] & 0x01) != 0);
        car.door_pass_open   = ((msg.data[5] & 0x02) != 0);
        car.door_rear_open   = ((msg.data[5] & 0x04) != 0);
        car.trunk_open       = ((msg.data[5] & 0x08) != 0);
        car.seatbelt_unbuckled = !((msg.data[2] & 0x40) != 0);
      }
      break;

    default:
      break;
  }
}

// --- NISSAN / INFINITI DECODER (Qashqai, X-Trail, Note, Sylphy, Tiida) ---
static void decodeNissanFrame(const twai_message_t& msg) {
  switch (msg.identifier) {
    // 0x002: Steering Wheel Angle
    case 0x002:
      if (msg.data_length_code >= 2) car.steering_angle_deg = (int16_t)((msg.data[0] << 8) | msg.data[1]) * 0.1f;
      break;

    // 0x180: Engine RPM & Ignition
    case 0x180:
      if (msg.data_length_code >= 2) {
        uint16_t r = (((uint16_t)msg.data[0] << 8) | msg.data[1]) / 2;
        car.rpm = r;
        if (r > 350) car.ignition = true;
      }
      break;

    // 0x280: Vehicle Speed
    case 0x280:
      if (msg.data_length_code >= 5) car.speed = msg.data[4];
      break;

    // 0x354: Accelerator Pedal Position
    case 0x354:
      if (msg.data_length_code >= 1) car.pedal_pct = (uint8_t)(msg.data[0] / 2.55f);
      break;

    // 0x421: Gear Position
    case 0x421:
      if (msg.data_length_code >= 1) {
        uint8_t g = msg.data[0];
        if (g == 0x00) car.gear = "P";
        else if (g == 0x08) car.gear = "R";
        else if (g == 0x10) car.gear = "N";
        else if (g == 0x18) car.gear = "D";
      }
      break;

    // 0x551: Fuel Level %
    case 0x551:
      if (msg.data_length_code >= 1) {
        car.fuel_pct = (msg.data[0] & 0x7F);
        car.low_fuel_warning = (car.fuel_pct <= 12.0f);
      }
      break;

    // 0x60D: Doors & Seatbelt
    case 0x60D:
      if (msg.data_length_code >= 2) {
        car.door_driver_open = ((msg.data[0] & 0x08) != 0);
        car.door_pass_open   = ((msg.data[0] & 0x04) != 0);
        car.trunk_open       = ((msg.data[0] & 0x02) != 0);
        car.seatbelt_unbuckled = ((msg.data[1] & 0x80) != 0);
      }
      break;

    default:
      break;
  }
}

// --- VAG DECODER (Volkswagen / Audi / Skoda / Seat) ---
static void decodeVagFrame(const twai_message_t& msg) {
  switch (msg.identifier) {
    // 0x086: Steering Wheel Angle
    case 0x086:
      if (msg.data_length_code >= 2) car.steering_angle_deg = (int16_t)((msg.data[1] << 8) | msg.data[0]) * 0.1f;
      break;

    // 0x280: Engine RPM & Cranking
    case 0x280:
      if (msg.data_length_code >= 4) {
        uint16_t r = (((uint16_t)msg.data[3] << 8) | msg.data[2]) / 4;
        car.rpm = r;
        if (r > 350) car.ignition = true;
      }
      break;

    // 0x320: Vehicle Speed
    case 0x320:
      if (msg.data_length_code >= 5) car.speed = msg.data[4];
      break;

    // 0x380 / 0x440: Gear Selector
    case 0x380:
    case 0x440:
      if (msg.data_length_code >= 1) {
        uint8_t g = msg.data[0];
        if (g == 0x01) car.gear = "P";
        else if (g == 0x02) car.gear = "R";
        else if (g == 0x03) car.gear = "N";
        else if (g == 0x04) car.gear = "D";
        else if (g == 0x05) car.gear = "S";
      }
      break;

    // 0x470: Doors Ajar
    case 0x470:
      if (msg.data_length_code >= 2) {
        car.door_driver_open = ((msg.data[1] & 0x01) != 0);
        car.door_pass_open   = ((msg.data[1] & 0x02) != 0);
        car.door_rear_open   = ((msg.data[1] & 0x0C) != 0);
        car.trunk_open       = ((msg.data[1] & 0x10) != 0);
      }
      break;

    // 0x570: Seatbelt
    case 0x570:
      if (msg.data_length_code >= 1) car.seatbelt_unbuckled = !((msg.data[0] & 0x04) != 0);
      break;

    default:
      break;
  }
}

// --- FORD / MAZDA DECODER ---
static void decodeFordFrame(const twai_message_t& msg) {
  switch (msg.identifier) {
    // 0x201: Engine RPM & Speed
    case 0x201:
      if (msg.data_length_code >= 6) {
        uint16_t r = (((uint16_t)msg.data[0] << 8) | msg.data[1]) / 4;
        car.rpm = r;
        if (r > 350) car.ignition = true;
        car.speed = (uint8_t)((((uint16_t)msg.data[4] << 8) | msg.data[5]) * 0.01f);
      }
      break;

    // 0x430: Doors & Seatbelt
    case 0x430:
      if (msg.data_length_code >= 3) {
        car.door_driver_open   = ((msg.data[2] & 0x01) != 0);
        car.door_pass_open     = ((msg.data[2] & 0x02) != 0);
        car.door_rear_open     = ((msg.data[2] & 0x0C) != 0);
        car.seatbelt_unbuckled = !((msg.data[0] & 0x04) != 0);
      }
      break;

    // 0x433: Gear Selector
    case 0x433:
      if (msg.data_length_code >= 1) {
        uint8_t g = msg.data[0];
        if (g == 0x01) car.gear = "P";
        else if (g == 0x02) car.gear = "R";
        else if (g == 0x03) car.gear = "N";
        else if (g == 0x04) car.gear = "D";
      }
      break;

    // 0x4B0: Wheel Speeds
    case 0x4B0:
      if (msg.data_length_code >= 8) {
        car.wheel_speed_fl = (((uint16_t)msg.data[0] << 8) | msg.data[1]) * 0.01f;
        car.wheel_speed_fr = (((uint16_t)msg.data[2] << 8) | msg.data[3]) * 0.01f;
      }
      break;

    default:
      break;
  }
}

// ============================================================================
// 5. UNIVERSAL STANDARD OBD-II RESPONSE DECODER (SAE J1979 / ISO 15765-4)
// Works universally across all vehicles worldwide (Gasoline, Diesel, Hybrid)
// ============================================================================
static void decodeStandardOBDResponse(const twai_message_t& msg) {
  // Service 01 Response: msg.data[1] == 0x41
  if (msg.data[1] == 0x41) {
    uint8_t pid = msg.data[2];
    uint8_t A   = msg.data[3];
    uint8_t B   = msg.data[4];

    car.ignition = true; // An active ECU responding to OBD is powered ON

    switch (pid) {
      // PID 0x00: Bitmask of supported PIDs 0x01-0x20
      case PID_SUPPORTED_PIDS_01_20:
        if (msg.data_length_code >= 7) {
          car.supported_pids_01_20 = ((uint32_t)A << 24) | ((uint32_t)B << 16) | ((uint32_t)msg.data[5] << 8) | msg.data[6];
          car.pid_discovery_done = true;
        }
        break;

      // PID 0x20: Bitmask of supported PIDs 0x21-0x40
      case PID_SUPPORTED_PIDS_21_40:
        if (msg.data_length_code >= 7) {
          car.supported_pids_21_40 = ((uint32_t)A << 24) | ((uint32_t)B << 16) | ((uint32_t)msg.data[5] << 8) | msg.data[6];
        }
        break;

      // PID 0x01: Monitor Status (MIL Check Engine Light)
      case PID_MONITOR_STATUS:
        car.check_engine_mil = ((A & 0x80) != 0);
        break;

      // PID 0x04: Calculated Engine Load (%)
      case PID_ENGINE_LOAD:
        car.engine_load_pct = A / 2.55f;
        break;

      // PID 0x05: Engine Coolant Temperature (°C)
      case PID_COOLANT_TEMP:
        car.coolant_temp_c = (int16_t)A - 40;
        break;

      // PID 0x0B: Intake Manifold Absolute Pressure (kPa)
      case PID_MAP_KPA:
        car.map_kpa = A;
        break;

      // PID 0x0C: Engine RPM (universal fallback if not on broadcast)
      case PID_ENGINE_RPM:
        if (car.rpm == 0 || car.make_family == MAKE_GENERIC_OBD) {
          car.rpm = ((uint16_t)A * 256 + B) / 4;
          if (car.rpm > 350) car.ignition = true;
        }
        break;

      // PID 0x0D: Vehicle Speed km/h (universal fallback)
      case PID_VEHICLE_SPEED:
        if (car.speed == 0 || car.make_family == MAKE_GENERIC_OBD) {
          car.speed = A;
        }
        break;

      // PID 0x0E: Timing Advance (° BTDC)
      case PID_TIMING_ADVANCE:
        car.timing_advance = (A / 2.0f) - 64.0f;
        break;

      // PID 0x0F: Intake Air Temperature (°C)
      case PID_INTAKE_TEMP:
        car.intake_air_temp = (int16_t)A - 40;
        break;

      // PID 0x10: Mass Air Flow (g/s)
      case PID_MAF_AIRFLOW:
        car.maf_gps = ((uint16_t)A * 256 + B) / 100.0f;
        break;

      // PID 0x11: Absolute Throttle Position (%)
      case PID_THROTTLE_POS:
      case PID_REL_THROTTLE:
        car.relative_throttle = A / 2.55f;
        if (car.pedal_pct == 0) car.pedal_pct = (uint8_t)car.relative_throttle;
        break;

      // PID 0x1F: Engine Runtime Since Start (seconds)
      case PID_RUNTIME_SEC:
        car.runtime_sec = ((uint32_t)A * 256) + B;
        break;

      // PID 0x2F: Fuel Tank Level (%)
      case PID_FUEL_LEVEL_OBD:
        if (car.fuel_pct == 0.0f || car.make_family == MAKE_GENERIC_OBD) {
          car.fuel_pct = A / 2.55f;
          car.low_fuel_warning = (car.fuel_pct <= 12.0f);
        }
        break;

      // PID 0x42: 12V Control Module Voltage (V)
      case PID_ECU_VOLTAGE:
        car.battery_12v = ((uint16_t)A * 256 + B) / 1000.0f;
        break;

      default:
        break;
    }
  }
  // Mode 03 DTC Response: msg.data[1] == 0x43
  else if (msg.data[1] == 0x43) {
    uint8_t dtc_count = msg.data[2];
    if (dtc_count == 0) {
      car.active_dtcs = "NONE";
    } else if (msg.data_length_code >= 5) {
      char code[8];
      char typeChar = 'P';
      uint8_t typeBits = (msg.data[3] & 0xC0) >> 6;
      if (typeBits == 1) typeChar = 'C';
      else if (typeBits == 2) typeChar = 'B';
      else if (typeBits == 3) typeChar = 'U';
      snprintf(code, sizeof(code), "%c%01X%02X", typeChar, msg.data[3] & 0x3F, msg.data[4]);
      car.active_dtcs = String(code);
    }
  }
}

// ============================================================================
// 6. MAIN CAN BUS RECEIVER & DISPATCHER LOOP
// ============================================================================
void processCANBus() {
  twai_message_t msg;

  while (twai_receive(&msg, 0) == ESP_OK) {
    if (msg.rtr) continue;

    portENTER_CRITICAL(&canDataMux);
    car.last_bus_activity_ms = millis();
    car.rx_frame_count++;

    // 1. Check for Standard OBD-II Responses (11-bit: 0x7E8..0x7EF or 29-bit: 0x18DAF110..17)
    bool is11BitObdResp = (!msg.extd && msg.identifier >= OBD_RESP_ID_11BIT_MIN && msg.identifier <= OBD_RESP_ID_11BIT_MAX);
    bool is29BitObdResp = (msg.extd && msg.identifier >= OBD_RESP_ID_29BIT_MIN && msg.identifier <= OBD_RESP_ID_29BIT_MAX);

    if (is11BitObdResp || is29BitObdResp) {
      if (is29BitObdResp) car.is_29bit_obd = true;
      decodeStandardOBDResponse(msg);
    }
    // 2. Passive OEM Broadcast Frames
    else if (!msg.extd) {
      // Auto-detect vehicle make signature if not yet confirmed
      if (car.make_family == MAKE_DETECTING) {
        detectVehicleMakeFromFrame(msg.identifier);
      }

      // Dispatch to specific manufacturer decoder
      switch (car.make_family) {
        case MAKE_HONDA:
          decodeHondaFrame(msg);
          break;
        case MAKE_TOYOTA:
          decodeToyotaFrame(msg);
          break;
        case MAKE_NISSAN:
          decodeNissanFrame(msg);
          break;
        case MAKE_VAG:
          decodeVagFrame(msg);
          break;
        case MAKE_FORD:
          decodeFordFrame(msg);
          break;
        case MAKE_DETECTING:
        case MAKE_GENERIC_OBD:
        default:
          // Try Honda and Toyota decoders as fallback
          decodeHondaFrame(msg);
          decodeToyotaFrame(msg);
          break;
      }
    }

    portEXIT_CRITICAL(&canDataMux);
  }
}

// ============================================================================
// 7. PERIODIC SERVICE & ACTIVE OBD-II POLLER (Called every loop cycle)
// ============================================================================
void serviceCANAndOBD() {
  // 1. Drain incoming TWAI RX FIFO buffer
  processCANBus();

  // 2. Bus Recovery & Health Check every 1000 ms
  if (millis() - lastBusRecoveryCheckMs >= 1000) {
    lastBusRecoveryCheckMs = millis();
    twai_status_info_t status;
    if (twai_get_status_info(&status) == ESP_OK) {
      if (status.state == TWAI_STATE_BUS_OFF) {
        car.bus_error_count++;
        Serial.println("[CAN] Bus-off detected! Initiating automatic recovery...");
        twai_initiate_recovery();
      } else if (status.state == TWAI_STATE_STOPPED) {
        twai_start();
      }
    }
  }

  // 3. Poll Active OBD-II PIDs every 75 ms (Full round-robin loop ~1.1s)
  if (millis() - lastObdQueryMs >= 75) {
    lastObdQueryMs = millis();

    uint8_t pidToQuery = CORE_OBD_PIDS[currentObdPidIdx];
    currentObdPidIdx = (currentObdPidIdx + 1) % TOTAL_CORE_OBD_PIDS;

    // Check if PID is supported (or if it's the discovery PID 0x00/0x20)
    bool isSupported = true;
    if (car.pid_discovery_done && pidToQuery >= 0x01 && pidToQuery <= 0x20) {
      uint32_t mask = (1UL << (32 - pidToQuery));
      isSupported = (car.supported_pids_01_20 & mask) != 0;
    }

    if (isSupported) {
      sendOBDQuery(pidToQuery);
    }
  }

  // 4. Query DTC Fault Codes (Mode 03) once every 15 seconds
  if (millis() - lastDtcQueryMs >= 15000) {
    lastDtcQueryMs = millis();
    sendDTCQuery();
  }
}

// ============================================================================
// 8. FREERTOS CORE 0 TASK (ISOLATED EXECUTION)
// Keeps 500kbps CAN bus servicing independent from GSM, GNSS and WiFi tasks
// ============================================================================
static void canWorkerTask(void* pvParameters) {
  Serial.println("[CAN] Universal CAN/OBD Background Worker running on Core 0");
  while (true) {
    serviceCANAndOBD();
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

void startCanTask() {
  if (canTaskHandle == NULL) {
    xTaskCreatePinnedToCore(
      canWorkerTask,
      "UniversalCAN",
      4096,
      NULL,
      1,
      &canTaskHandle,
      0 // Core 0
    );
  }
}

// ============================================================================
// 9. SERIALIZE TELEMETRY TO UNIFIED JSON ROW
// Normalizes and merges all active CAN & OBD fields into the tracking packet
// ============================================================================
void populateTelemetryJsonRow(JsonObject& obj) {
  portENTER_CRITICAL(&canDataMux);

  // Bus timeout: If no CAN packets seen for > 3.5s, vehicle is parked/off
  bool busAwake = (millis() - car.last_bus_activity_ms < 3500);
  if (!busAwake) {
    car.ignition = false;
    car.rpm = 0;
    car.speed = 0;
    car.engine_load_pct = 0.0f;
  }

  // Vehicle identification & protocol telemetry
  obj["can_make"]       = car.vehicle_make;
  obj["can_baud"]       = car.bus_baud_rate;

  // Dedicated top-level CAN / OBD columns
  obj["rpm"]            = car.rpm;
  obj["fuel_level"]     = round(car.fuel_pct * 10) / 10.0;
  obj["engine_temp"]    = car.coolant_temp_c;
  obj["dtc"]            = car.active_dtcs;

  // Powertrain & Driving
  obj["obd_speed"]      = car.speed;
  obj["gear"]           = car.gear;
  obj["pedal_pct"]      = car.pedal_pct;
  obj["steering_deg"]   = round(car.steering_angle_deg * 10) / 10.0;

  // Wheel Speeds & Safety Dynamics
  obj["ws_fl"]          = round(car.wheel_speed_fl * 10) / 10.0;
  obj["ws_fr"]          = round(car.wheel_speed_fr * 10) / 10.0;
  obj["ws_rl"]          = round(car.wheel_speed_rl * 10) / 10.0;
  obj["ws_rr"]          = round(car.wheel_speed_rr * 10) / 10.0;
  obj["traction_loss"]  = car.traction_loss;
  obj["brake_pressed"]  = car.brake_pressed;
  obj["brake_bar"]      = round(car.brake_pressure_bar * 10) / 10.0;
  obj["abs_active"]     = car.abs_active;
  obj["lateral_g"]      = round(car.lateral_g * 100) / 100.0;
  obj["yaw_rate"]       = round(car.yaw_rate * 10) / 10.0;
  obj["crash_flag"]     = car.crash_detected;

  // Hybrid / EV System (Toyota THS / Honda IMA / Nissan e-Power)
  obj["hybrid_soc"]     = car.hybrid_soc_pct;
  obj["motor_kw"]       = car.hybrid_motor_kw;
  obj["inverter_temp"]  = car.inverter_temp_c;
  obj["battery_temp"]   = car.batt_temp_c;
  obj["hybrid_auto_stop"] = car.hybrid_auto_stop;

  // Fuel & Fluids
  obj["fuel_pct"]       = round(car.fuel_pct * 10) / 10.0;
  obj["low_fuel"]       = car.low_fuel_warning;
  obj["coolant_temp"]   = car.coolant_temp_c;
  obj["cvt_fluid_temp"] = car.cvt_fluid_temp_c;

  // Body, Security & Accessories
  obj["door_driver"]    = car.door_driver_open;
  obj["door_passenger"] = car.door_pass_open;
  obj["door_rear"]      = car.door_rear_open;
  obj["trunk"]          = car.trunk_open;
  obj["seatbelt_unbuckled"] = car.seatbelt_unbuckled;
  obj["headlights"]     = car.headlights_on;
  obj["highbeam"]       = car.highbeam_on;
  obj["hazards"]        = car.hazard_lights_on;
  obj["ac_on"]          = car.ac_compressor_on;
  obj["tpms_warning"]   = car.tpms_warning;
  obj["handbrake"]      = car.handbrake_engaged;
  obj["check_engine_mil"] = car.check_engine_mil;
  obj["oil_life_pct"]   = car.oil_life_pct;
  obj["battery_12v"]    = round(car.battery_12v * 10) / 10.0;

  // Standard OBD-II Live Diagnostics
  obj["engine_load"]    = round(car.engine_load_pct * 10) / 10.0;
  obj["map_kpa"]        = car.map_kpa;
  obj["timing_advance"] = round(car.timing_advance * 10) / 10.0;
  obj["intake_temp"]    = car.intake_air_temp;
  obj["maf_gps"]        = round(car.maf_gps * 10) / 10.0;
  obj["runtime_sec"]    = car.runtime_sec;
  obj["throttle_pct"]   = round(car.relative_throttle * 10) / 10.0;

  portEXIT_CRITICAL(&canDataMux);
}
