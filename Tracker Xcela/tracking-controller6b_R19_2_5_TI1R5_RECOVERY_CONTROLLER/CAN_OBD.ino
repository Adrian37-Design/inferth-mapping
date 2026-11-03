#include "CAN_OBD.h"

// ============================================================================
// HONDA FIT GP1 HYBRID TELEMETRY ENGINE & TWAI DRIVER
// Pinned to ESP32-S3 Hardware TWAI Controller (CAN_TX=41, CAN_RX=42 @ 500 kbps)
//
// STRICT EXCLUSIONS IMPLEMENTED:
// - Micro-control chatter / Noise (0x136, 0x158, 0x166, 0x1B0, 0x1DC, 0x221, 0x377, 0x385)
// - Outside Ambient Temperature (0x386)
// - Windshield Rain / Wipers (0x40C)
// - Vehicle VIN (OBD Mode 09 PID 02)
// ============================================================================

VehicleTelemetry car;
portMUX_TYPE canDataMux = portMUX_INITIALIZER_UNLOCKED;

static const uint8_t ACTIVE_CAN_PIDS[] = {
  PID_ENGINE_LOAD,
  PID_COOLANT_TEMP,
  PID_MAP_KPA,
  PID_TIMING_ADVANCE,
  PID_INTAKE_TEMP,
  PID_MAF_AIRFLOW,
  PID_RUNTIME_SEC,
  PID_FUEL_LEVEL_OBD,
  PID_ECU_VOLTAGE,
  PID_REL_THROTTLE
};
static const uint8_t TOTAL_ACTIVE_CAN_PIDS = sizeof(ACTIVE_CAN_PIDS) / sizeof(ACTIVE_CAN_PIDS[0]);

static uint8_t currentActiveCanPidIdx = 0;
static uint32_t lastCanPidQueryMs = 0;
static uint32_t lastCanDtcCheckMs = 0;
static TaskHandle_t canTaskHandle = NULL;

// ============================================================================
// TWAI (CAN) CONTROLLER INITIALIZATION
// ============================================================================
bool initTWAI() {
  twai_general_config_t g_config = TWAI_GENERAL_CONFIG_DEFAULT(CAN_TX_PIN, CAN_RX_PIN, TWAI_MODE_NORMAL);
  g_config.rx_queue_len = 128;
  g_config.tx_queue_len = 16;

  twai_timing_config_t t_config = TWAI_TIMING_CONFIG_500KBITS();
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

  Serial.println("[CAN] TWAI 500kbps Controller Running (Normal Mode TX=41, RX=42)");
  return true;
}

// ============================================================================
// ACTIVE OBD QUERY TRANSMITTER (0x7DF)
// ============================================================================
bool sendOBDQuery(uint8_t pid) {
  twai_message_t query;
  query.identifier = OBD_REQ_ID;
  query.extd = 0;
  query.rtr = 0;
  query.data_length_code = 8;
  query.data[0] = 0x02; // 2 payload bytes
  query.data[1] = 0x01; // Service 01 (Powertrain Live Data)
  query.data[2] = pid;  // PID
  query.data[3] = 0x55; // ISO-TP padding
  query.data[4] = 0x55;
  query.data[5] = 0x55;
  query.data[6] = 0x55;
  query.data[7] = 0x55;

  return (twai_transmit(&query, pdMS_TO_TICKS(15)) == ESP_OK);
}

// Query Active Diagnostic Trouble Codes (Mode 03)
bool sendDTCQuery() {
  twai_message_t query;
  query.identifier = OBD_REQ_ID;
  query.extd = 0;
  query.rtr = 0;
  query.data_length_code = 8;
  query.data[0] = 0x01;
  query.data[1] = 0x03; // Mode 03 (Request Emission-Related DTCs)
  for (int i = 2; i < 8; i++) query.data[i] = 0x55;
  return (twai_transmit(&query, pdMS_TO_TICKS(15)) == ESP_OK);
}

// ============================================================================
// CAN BUS PROCESSING ENGINE (PASSIVE BROADCASTS + ACTIVE OBD RESPONSES)
// ============================================================================
void processCANBus() {
  twai_message_t msg;

  while (twai_receive(&msg, 0) == ESP_OK) {
    if (msg.rtr || msg.extd) continue;

    portENTER_CRITICAL(&canDataMux);
    car.last_bus_activity_ms = millis();

    // ------------------------------------------------------------------------
    // 1. ACTIVE OBD-II RESPONSES (0x7E8 - 0x7EF)
    // ------------------------------------------------------------------------
    if (msg.identifier >= 0x7E8 && msg.identifier <= 0x7EF) {
      if (msg.data[1] == 0x41) { // Positive reply to Service 01
        uint8_t pid = msg.data[2];
        uint8_t A   = msg.data[3];
        uint8_t B   = msg.data[4];

        car.ignition = true;

        switch (pid) {
          case PID_ENGINE_LOAD:    car.engine_load_pct = A / 2.55f; break;
          case PID_COOLANT_TEMP:   car.coolant_temp_c = (int16_t)A - 40; break;
          case PID_MAP_KPA:        car.map_kpa = A; break;
          case PID_TIMING_ADVANCE: car.timing_advance = (A / 2.0f) - 64.0f; break;
          case PID_INTAKE_TEMP:    car.intake_air_temp = (int16_t)A - 40; break;
          case PID_MAF_AIRFLOW:    car.maf_gps = ((uint16_t)A * 256 + B) / 100.0f; break;
          case PID_RUNTIME_SEC:    car.runtime_sec = ((uint32_t)A * 256) + B; break;
          case PID_FUEL_LEVEL_OBD: if (car.fuel_pct == 0.0) car.fuel_pct = A / 2.55f; break;
          case PID_ECU_VOLTAGE:    car.battery_12v = ((uint16_t)A * 256 + B) / 1000.0f; break;
          case PID_REL_THROTTLE:   car.relative_throttle = A / 2.55f; break;
        }
      }
      else if (msg.data[1] == 0x43) { // Mode 03 DTC Response
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
    // ------------------------------------------------------------------------
    // 2. PASSIVE HONDA F-CAN BROADCASTS
    // ------------------------------------------------------------------------
    else {
      switch (msg.identifier) {

        // 0x039: SRS Airbag Module (Crash/Impact Detection)
        case 0x039:
          if (msg.data_length_code >= 2) {
            car.crash_detected = (msg.data[0] != 0x00 || (msg.data[1] & 0x01) != 0);
          }
          break;

        // 0x13F: Accelerator Pedal Position (APP)
        case 0x13F:
          if (msg.data_length_code >= 2) {
            car.pedal_pct = map(msg.data[1], 0, 255, 0, 100);
          }
          break;

        // 0x143: Steering Wheel Angle (Harsh Cornering / Swerve)
        case 0x143:
          if (msg.data_length_code >= 2) {
            int16_t raw_angle = ((int16_t)msg.data[0] << 8) | msg.data[1];
            car.steering_angle_deg = raw_angle * 0.1f;
          }
          break;

        // 0x161: Individual 4-Wheel Speeds (Traction loss / Wheel slip)
        case 0x161:
          if (msg.data_length_code >= 8) {
            car.wheel_speed_fl = (((uint16_t)msg.data[0] << 8) | msg.data[1]) * 0.01f;
            car.wheel_speed_fr = (((uint16_t)msg.data[2] << 8) | msg.data[3]) * 0.01f;
            car.wheel_speed_rl = (((uint16_t)msg.data[4] << 8) | msg.data[5]) * 0.01f;
            car.wheel_speed_rr = (((uint16_t)msg.data[6] << 8) | msg.data[7]) * 0.01f;
          }
          break;

        // 0x164: Vehicle Speed & Automatic Gear Shift Selector
        case 0x164:
          if (msg.data_length_code >= 5) {
            car.speed = msg.data[3];
            uint8_t gearByte = msg.data[4];
            if (gearByte == 0xB1) car.gear = "P";
            else if (gearByte == 0xB2) car.gear = "R";
            else if (gearByte == 0xB3) car.gear = "N";
            else if (gearByte == 0xB4 || gearByte == 0x20) car.gear = "D";
          }
          break;

        // 0x17C: Engine RPM & Cranking/Ignition Running Flag
        case 0x17C:
          if (msg.data_length_code >= 4) {
            uint16_t raw_rpm = ((uint16_t)msg.data[2] << 8) | msg.data[3];
            car.rpm = raw_rpm;
            if (raw_rpm > 350) car.ignition = true;
          }
          break;

        // 0x18E: VSA / Traction Control Intervention (Skid alert)
        case 0x18E:
          if (msg.data_length_code >= 1) {
            car.traction_loss = ((msg.data[0] & 0x02) != 0);
          }
          break;

        // 0x191: IMA Hybrid Motor Assist (kW) / Regenerative Braking Power
        case 0x191:
          if (msg.data_length_code >= 4) {
            int16_t raw_kw = ((int16_t)msg.data[2] << 8) | msg.data[3];
            car.hybrid_motor_kw = raw_kw / 10;
          }
          break;

        // 0x1A4: Brake Switch, Master Cylinder Hydraulic Pressure (Bar), ABS
        case 0x1A4:
          if (msg.data_length_code >= 4) {
            car.brake_pressed = ((msg.data[0] & 0x80) != 0);
            car.abs_active    = ((msg.data[0] & 0x08) != 0);
            uint16_t raw_bar  = ((msg.data[2] & 0x7F) << 8) | msg.data[3];
            car.brake_pressure_bar = raw_bar * 0.1f;
          }
          break;

        // 0x1AA: Yaw Rate & Lateral Acceleration (Rollover/Drift)
        case 0x1AA:
          if (msg.data_length_code >= 4) {
            int16_t raw_yaw = ((int16_t)msg.data[0] << 8) | msg.data[1];
            int16_t raw_lat = ((int16_t)msg.data[2] << 8) | msg.data[3];
            car.yaw_rate  = raw_yaw * 0.05f;
            car.lateral_g = raw_lat * 0.005f;
          }
          break;

        // 0x1CF: Inverter IGBT Temperature & High Voltage Contactor
        case 0x1CF:
          if (msg.data_length_code >= 3) {
            car.inverter_temp_c = (int16_t)msg.data[2] - 40;
          }
          break;

        // 0x1D0: IMA Eco Auto-Stop (Traffic Light Engine Stop vs Stall)
        case 0x1D0:
          if (msg.data_length_code >= 2) {
            car.hybrid_auto_stop = ((msg.data[1] & 0x08) != 0);
          }
          break;

        // 0x21E: Honda IMA Hybrid Battery State of Charge (SoC %)
        case 0x21E:
          if (msg.data_length_code >= 3) {
            car.hybrid_soc_pct = msg.data[2] / 2; // Scaled 0 to 100%
          }
          break;

        // 0x294: Hybrid Battery Pack Temperature (°C)
        case 0x294:
          if (msg.data_length_code >= 4) {
            car.batt_temp_c = (int16_t)msg.data[1] - 40;
          }
          break;

        // 0x305: Physical Key In Barrel & ACC Switch State
        case 0x305:
          if (msg.data_length_code >= 2) {
            car.key_in_barrel = ((msg.data[0] & 0x01) != 0);
            if ((msg.data[0] & 0x02) != 0) car.ignition = true;
          }
          break;

        // 0x320: CVT Automatic Transmission Fluid Temp (°C)
        case 0x320:
          if (msg.data_length_code >= 2) {
            car.cvt_fluid_temp_c = (int16_t)msg.data[1] - 40;
          }
          break;

        // 0x324: Check Engine Light (MIL), Handbrake & ABS Warning Lamps
        case 0x324:
          if (msg.data_length_code >= 3) {
            car.check_engine_mil  = ((msg.data[0] & 0x40) != 0);
            car.handbrake_engaged = ((msg.data[1] & 0x04) != 0);
          }
          break;

        // 0x374: Climate Control A/C Compressor Clutch
        case 0x374:
          if (msg.data_length_code >= 2) {
            car.ac_compressor_on = ((msg.data[1] & 0x04) != 0);
          }
          break;

        // 0x378: Exterior Lighting (Headlights, Highbeams, Turn Signals)
        case 0x378:
          if (msg.data_length_code >= 3) {
            car.headlights_on        = ((msg.data[0] & 0x04) != 0);
            car.highbeam_on          = ((msg.data[0] & 0x08) != 0);
            car.turn_signal_active   = ((msg.data[1] & 0x03) != 0);
            car.hazard_lights_on     = ((msg.data[1] & 0x04) != 0);
          }
          break;

        // 0x384: Fuel Tank Float Level (%) & Low Fuel Alert
        case 0x384:
          if (msg.data_length_code >= 2) {
            car.fuel_pct = msg.data[1]; // Direct 0-100% fuel level
            car.low_fuel_warning = (car.fuel_pct <= 12.0f);
          }
          break;

        // 0x3D7: TPMS Low Tire Pressure Warning
        case 0x3D7:
          if (msg.data_length_code >= 2) {
            car.tpms_warning = ((msg.data[1] & 0x80) != 0);
          }
          break;

        // 0x405: Doors Ajar, Driver Seatbelt Buckle, Backup Coolant Temp
        case 0x405:
          if (msg.data_length_code >= 3) {
            car.seatbelt_unbuckled = ((msg.data[0] & 0x10) != 0);
            car.door_driver_open   = ((msg.data[1] & 0x01) != 0);
            car.door_pass_open     = ((msg.data[1] & 0x02) != 0);
            car.door_rear_open     = ((msg.data[1] & 0x04) != 0);
            car.trunk_open         = ((msg.data[1] & 0x08) != 0);

            if (car.coolant_temp_c == 0 && msg.data[2] > 0) {
              car.coolant_temp_c = (int16_t)msg.data[2] - 40;
            }
          }
          break;

        // 0x454: Immobilizer Security Key Challenge
        case 0x454:
          if (msg.data_length_code >= 2) {
            car.immobilizer_auth = (msg.data[0] == 0x00);
          }
          break;

        // 0x465: Maintenance Minder (Oil Life %)
        case 0x465:
          if (msg.data_length_code >= 2) {
            car.oil_life_pct = msg.data[1];
          }
          break;

        // 0x6C1: Odometer Pulse Count
        case 0x6C1:
          car.odometer_pulses++;
          break;

        // All noise (0x136, 0x158, 0x166, 0x1B0, 0x1DC, 0x221, 0x377, 0x385)
        // plus excluded Outside Temp (0x386), Wipers (0x40C) fall through cleanly:
        default:
          break;
      }
    }

    portEXIT_CRITICAL(&canDataMux);
  }
}

// ============================================================================
// SERVICE CAN AND OBD (CALLED PERIODICALLY)
// ============================================================================
void serviceCANAndOBD() {
  // 1. Drain incoming TWAI RX FIFO buffer
  processCANBus();

  // 2. Poll Active OBD-II PIDs every 80 ms (Round-robin cycle = 800 ms)
  if (millis() - lastCanPidQueryMs >= 80) {
    lastCanPidQueryMs = millis();
    sendOBDQuery(ACTIVE_CAN_PIDS[currentActiveCanPidIdx]);
    currentActiveCanPidIdx = (currentActiveCanPidIdx + 1) % TOTAL_ACTIVE_CAN_PIDS;
  }

  // 3. Poll Diagnostic Trouble Codes (DTCs) once every 60 seconds
  if (millis() - lastCanDtcCheckMs >= 60000) {
    lastCanDtcCheckMs = millis();
    sendDTCQuery();
  }
}

// ============================================================================
// FREERTOS BACKGROUND TASK
// Pinned to Core 0 to service 500kbps CAN frames without dropping packets
// ============================================================================
static void canBusTask(void *pvParameters) {
  while (true) {
    serviceCANAndOBD();
    vTaskDelay(pdMS_TO_TICKS(10)); // 10ms yield gives high responsiveness
  }
}

void startCanTask() {
  if (canTaskHandle == NULL) {
    xTaskCreatePinnedToCore(
      canBusTask,
      "CAN_OBD_Task",
      4096,
      NULL,
      1,
      &canTaskHandle,
      0 // Core 0
    );
  }
}

// ============================================================================
// POPULATE TELEMETRY JSON ROW
// Thread-safely merges all live CAN & OBD fields into the tracking JSON
// ============================================================================
void populateTelemetryJsonRow(JsonObject& obj) {
  portENTER_CRITICAL(&canDataMux);

  // Bus timeout: If no CAN packets seen for > 3.5s, ignition is OFF and dynamic values zeroed
  bool busAwake = (millis() - car.last_bus_activity_ms < 3500);
  if (!busAwake) {
    car.ignition = false;
    car.rpm = 0;
    car.speed = 0;
    car.engine_load_pct = 0.0f;
  }

  // Dedicated top-level CAN / OBD columns matching backend schema
  obj["rpm"]            = car.rpm;
  obj["fuel_level"]     = round(car.fuel_pct * 10) / 10.0;
  obj["engine_temp"]    = car.coolant_temp_c;
  obj["dtc"]            = car.active_dtcs;

  // Extended Powertrain & Driving
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

  // IMA Hybrid System
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

  // Active OBD Diagnostics
  obj["engine_load"]    = round(car.engine_load_pct * 10) / 10.0;
  obj["map_kpa"]        = car.map_kpa;
  obj["timing_advance"] = round(car.timing_advance * 10) / 10.0;
  obj["intake_temp"]    = car.intake_air_temp;
  obj["maf_gps"]        = round(car.maf_gps * 10) / 10.0;
  obj["runtime_sec"]    = car.runtime_sec;
  obj["throttle_pct"]   = round(car.relative_throttle * 10) / 10.0;

  portEXIT_CRITICAL(&canDataMux);
}
