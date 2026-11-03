#pragma once

#include <Arduino.h>
#include <driver/twai.h>
#include <ArduinoJson.h>

// TWAI CAN Pin Configuration for ESP32-S3 (XCELAV4)
#ifndef CAN_TX_PIN
#define CAN_TX_PIN GPIO_NUM_41
#endif

#ifndef CAN_RX_PIN
#define CAN_RX_PIN GPIO_NUM_42
#endif

// Active OBD-II IDs
#define OBD_REQ_ID   0x7DF
#define OBD_RESP_ID  0x7E8

enum OBD_PID {
  PID_ENGINE_LOAD    = 0x04,
  PID_COOLANT_TEMP   = 0x05,
  PID_MAP_KPA        = 0x0B,
  PID_TIMING_ADVANCE = 0x0E,
  PID_INTAKE_TEMP    = 0x0F,
  PID_MAF_AIRFLOW    = 0x10,
  PID_RUNTIME_SEC    = 0x1F,
  PID_FUEL_LEVEL_OBD = 0x2F,
  PID_ECU_VOLTAGE    = 0x42,
  PID_REL_THROTTLE   = 0x45,
};

// ============================================================================
// COMPREHENSIVE HONDA FIT GP1 HYBRID TELEMETRY STATE
// ============================================================================
struct VehicleTelemetry {
  // --- Powertrain & Driving ---
  uint16_t rpm = 0;                  // 0x17C
  uint8_t  speed = 0;                // 0x164 (km/h)
  String   gear = "P";               // 0x164 (P, R, N, D)
  uint8_t  pedal_pct = 0;            // 0x13F (0-100%)
  float    steering_angle_deg = 0.0; // 0x143 (-500 to +500 deg)
  bool     ignition = false;         // 0x17C / 0x305

  // --- Wheel Speeds & Safety Dynamics ---
  float    wheel_speed_fl = 0.0;     // 0x161 (km/h)
  float    wheel_speed_fr = 0.0;
  float    wheel_speed_rl = 0.0;
  float    wheel_speed_rr = 0.0;
  bool     traction_loss = false;    // 0x18E (ESP / VSA active)
  bool     brake_pressed = false;    // 0x1A4 (Brake switch)
  float    brake_pressure_bar = 0.0; // 0x1A4 (0 to >100 Bar)
  bool     abs_active = false;       // 0x1A4
  float    lateral_g = 0.0;          // 0x1AA (m/s^2)
  float    yaw_rate = 0.0;           // 0x1AA (deg/sec)
  bool     crash_detected = false;   // 0x039 (SRS Airbag deployment flag)

  // --- IMA Hybrid System ---
  uint8_t  hybrid_soc_pct = 0;       // 0x21E (IMA Battery %)
  int16_t  hybrid_motor_kw = 0;      // 0x191 (+Assist / -Regen kW)
  int16_t  inverter_temp_c = 0;      // 0x1CF
  int16_t  batt_temp_c = 0;          // 0x294 (Module average)
  bool     hybrid_auto_stop = false; // 0x1D0 (Eco Idle Stop active)

  // --- Fuel & Fluids ---
  float    fuel_pct = 0.0;           // 0x384 (Cluster float)
  bool     low_fuel_warning = false; // 0x384
  int16_t  coolant_temp_c = 0;       // 0x405 / OBD PID 0x05
  int16_t  cvt_fluid_temp_c = 0;     // 0x320

  // --- Body, Security & Accessories ---
  bool     door_driver_open = false; // 0x405
  bool     door_pass_open = false;
  bool     door_rear_open = false;
  bool     trunk_open = false;
  bool     seatbelt_unbuckled = false;// 0x405
  bool     headlights_on = false;    // 0x378
  bool     highbeam_on = false;
  bool     hazard_lights_on = false;
  bool     turn_signal_active = false;
  bool     ac_compressor_on = false; // 0x374
  bool     tpms_warning = false;     // 0x3D7 (Tire pressure)
  bool     handbrake_engaged = false;// 0x324
  bool     check_engine_mil = false; // 0x324
  bool     key_in_barrel = false;    // 0x305
  bool     immobilizer_auth = true;  // 0x454
  uint8_t  oil_life_pct = 100;       // 0x465 (Maintenance Minder)
  uint32_t odometer_pulses = 0;      // 0x6C1

  // --- Active OBD-II Parameters ---
  float    engine_load_pct = 0.0;    // PID 0x04
  uint8_t  map_kpa = 0;              // PID 0x0B
  float    timing_advance = 0.0;     // PID 0x0E
  int16_t  intake_air_temp = 0;      // PID 0x0F
  float    maf_gps = 0.0;            // PID 0x10
  uint32_t runtime_sec = 0;          // PID 0x1F
  float    battery_12v = 0.0;        // PID 0x42
  float    relative_throttle = 0.0;  // PID 0x45
  String   active_dtcs = "NONE";

  uint32_t last_bus_activity_ms = 0;
};

extern VehicleTelemetry car;
extern portMUX_TYPE canDataMux;

bool initTWAI();
bool sendOBDQuery(uint8_t pid);
bool sendDTCQuery();
void processCANBus();
void serviceCANAndOBD();
void startCanTask();
void populateTelemetryJsonRow(JsonObject& obj);
