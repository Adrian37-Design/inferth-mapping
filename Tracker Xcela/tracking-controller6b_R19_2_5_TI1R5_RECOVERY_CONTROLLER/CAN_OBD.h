#pragma once

#include <Arduino.h>
#include <driver/twai.h>
#include <ArduinoJson.h>

// ============================================================================
// UNIVERSAL AUTOMOTIVE CAN & OBD-II TELEMETRY ENGINE
// Hardware: ESP32-S3 TWAI Controller (CAN_TX=GPIO 41, CAN_RX=GPIO 42)
// Compatibility: Universal (Toyota, Honda, Nissan, VAG, Ford, Generic OBD-II)
// ============================================================================

#ifndef CAN_TX_PIN
#define CAN_TX_PIN GPIO_NUM_41
#endif

#ifndef CAN_RX_PIN
#define CAN_RX_PIN GPIO_NUM_42
#endif

// Standard OBD-II Request & Response IDs
#define OBD_REQ_ID_11BIT    0x7DF
#define OBD_RESP_ID_11BIT_MIN 0x7E8
#define OBD_RESP_ID_11BIT_MAX 0x7EF

#define OBD_REQ_ID_29BIT    0x18DB33F1
#define OBD_RESP_ID_29BIT_MIN 0x18DAF110
#define OBD_RESP_ID_29BIT_MAX 0x18DAF117

// Standard OBD-II Mode 01 PIDs
enum OBD_PID {
  PID_SUPPORTED_PIDS_01_20 = 0x00,
  PID_MONITOR_STATUS       = 0x01,
  PID_FUEL_SYS_STATUS      = 0x03,
  PID_ENGINE_LOAD          = 0x04,
  PID_COOLANT_TEMP         = 0x05,
  PID_SHORT_FUEL_TRIM_1    = 0x06,
  PID_LONG_FUEL_TRIM_1     = 0x07,
  PID_MAP_KPA              = 0x0B,
  PID_ENGINE_RPM           = 0x0C,
  PID_VEHICLE_SPEED        = 0x0D,
  PID_TIMING_ADVANCE       = 0x0E,
  PID_INTAKE_TEMP          = 0x0F,
  PID_MAF_AIRFLOW          = 0x10,
  PID_THROTTLE_POS         = 0x11,
  PID_SUPPORTED_PIDS_21_40 = 0x20,
  PID_RUNTIME_SEC          = 0x1F,
  PID_DISTANCE_WITH_MIL    = 0x21,
  PID_FUEL_RAIL_PRESSURE   = 0x23,
  PID_FUEL_LEVEL_OBD       = 0x2F,
  PID_EVAP_PRESSURE        = 0x32,
  PID_SUPPORTED_PIDS_41_60 = 0x40,
  PID_ECU_VOLTAGE          = 0x42,
  PID_REL_THROTTLE         = 0x45,
  PID_OIL_TEMP             = 0x5C,
  PID_FUEL_RATE            = 0x5E
};

// Auto-Detected Vehicle Make Families
enum VehicleMakeFamily {
  MAKE_DETECTING = 0,
  MAKE_HONDA,        // Honda / Acura
  MAKE_TOYOTA,       // Toyota / Lexus / Scion
  MAKE_NISSAN,       // Nissan / Infiniti
  MAKE_VAG,          // Volkswagen / Audi / Skoda / Seat
  MAKE_FORD,         // Ford / Lincoln / Mazda
  MAKE_GENERIC_OBD   // Universal SAE J1979 OBD-II standard fallback
};

// Supported Baud Rates
enum CANBaudRate {
  BAUD_UNKNOWN = 0,
  BAUD_500K    = 500,
  BAUD_250K    = 250,
  BAUD_125K    = 125
};

// ============================================================================
// UNIFIED UNIVERSAL VEHICLE TELEMETRY STATE
// Normalized representation across all car makes and protocols
// ============================================================================
struct VehicleTelemetry {
  // --- Auto-Identification Metadata ---
  VehicleMakeFamily make_family = MAKE_DETECTING;
  String   vehicle_make = "DETECTING...";
  uint16_t bus_baud_rate = 500;
  bool     is_29bit_obd = false;
  uint32_t supported_pids_01_20 = 0xFFFFFFFF; // Defaults to open until scanned
  uint32_t supported_pids_21_40 = 0;
  bool     pid_discovery_done = false;

  // --- Powertrain & Driving ---
  uint16_t rpm = 0;                  // Broadcast or OBD PID 0x0C
  uint8_t  speed = 0;                // Broadcast or OBD PID 0x0D (km/h)
  String   gear = "P";               // P, R, N, D, S, M, B
  uint8_t  pedal_pct = 0;            // 0-100% Accelerator pedal position
  float    steering_angle_deg = 0.0; // Steering angle (- = left, + = right)
  bool     ignition = false;         // Ignition / Cranking detection

  // --- Wheel Speeds & Safety Dynamics ---
  float    wheel_speed_fl = 0.0;     // Front-Left (km/h)
  float    wheel_speed_fr = 0.0;     // Front-Right (km/h)
  float    wheel_speed_rl = 0.0;     // Rear-Left (km/h)
  float    wheel_speed_rr = 0.0;     // Rear-Right (km/h)
  bool     traction_loss = false;    // ESP / VSA / VSC intervention
  bool     brake_pressed = false;    // Brake switch
  float    brake_pressure_bar = 0.0; // Master cylinder pressure (Bar)
  bool     abs_active = false;       // ABS active flag
  float    lateral_g = 0.0;          // Lateral acceleration (g or m/s^2)
  float    yaw_rate = 0.0;           // Yaw rate (deg/sec)
  bool     crash_detected = false;   // Airbag / SRS deployment flag

  // --- Hybrid / EV System (Toyota Prius/Aqua, Honda IMA, Nissan e-Power) ---
  uint8_t  hybrid_soc_pct = 0;       // Hybrid Battery State of Charge (0-100%)
  int16_t  hybrid_motor_kw = 0;      // Motor output (+Assist / -Regen kW)
  int16_t  inverter_temp_c = 0;      // Inverter / Power module temperature (°C)
  int16_t  batt_temp_c = 0;          // Traction pack temperature (°C)
  bool     hybrid_auto_stop = false; // Eco idle-stop engaged

  // --- Fuel & Fluids ---
  float    fuel_pct = 0.0;           // Fuel level percentage (0-100%)
  bool     low_fuel_warning = false; // Low fuel indicator (<= 12%)
  int16_t  coolant_temp_c = 0;       // Engine coolant temperature (°C)
  int16_t  cvt_fluid_temp_c = 0;     // Transmission fluid temperature (°C)
  uint8_t  oil_life_pct = 100;       // Engine oil life remaining (%)

  // --- Body, Security & Accessories ---
  bool     door_driver_open = false; // Driver door ajar
  bool     door_pass_open = false;   // Passenger door ajar
  bool     door_rear_open = false;   // Rear door(s) ajar
  bool     trunk_open = false;       // Trunk / Boot open
  bool     seatbelt_unbuckled = false;// Driver seatbelt unlatched
  bool     headlights_on = false;    // Headlights on
  bool     highbeam_on = false;      // High beam headlights
  bool     hazard_lights_on = false; // Hazard flashers
  bool     turn_signal_active = false;
  bool     ac_compressor_on = false; // A/C compressor clutch engaged
  bool     tpms_warning = false;     // Low tire pressure warning
  bool     handbrake_engaged = false;// Parking brake engaged
  bool     check_engine_mil = false; // Check Engine Light (MIL)
  bool     key_in_barrel = false;    // Physical key presence
  bool     immobilizer_auth = true;  // Immobilizer transponder authenticated
  uint32_t odometer_pulses = 0;      // Accumulated distance pulses

  // --- Standard OBD-II Live Diagnostics ---
  float    engine_load_pct = 0.0;    // Calculated Engine Load (%)
  uint8_t  map_kpa = 0;              // Manifold Absolute Pressure (kPa)
  float    timing_advance = 0.0;     // Timing Advance (° BTDC)
  int16_t  intake_air_temp = 0;      // Intake Air Temp (°C)
  float    maf_gps = 0.0;            // Mass Air Flow (g/s)
  uint32_t runtime_sec = 0;          // Engine run time since start (s)
  float    battery_12v = 0.0;        // 12V Control Module Voltage (V)
  float    relative_throttle = 0.0;  // Throttle Position (%)
  String   active_dtcs = "NONE";     // Active Diagnostic Trouble Codes

  // --- Bus Diagnostics ---
  uint32_t last_bus_activity_ms = 0;
  uint32_t rx_frame_count = 0;
  uint32_t tx_frame_count = 0;
  uint32_t bus_error_count = 0;
};

// Global telemetry instance & thread safety mutex
extern VehicleTelemetry car;
extern portMUX_TYPE canDataMux;

// Universal Driver Lifecycle
bool initTWAI();
void startCanTask();
void serviceCANAndOBD();
void processCANBus();
void populateTelemetryJsonRow(JsonObject& obj);

// Universal OBD-II Query Helpers
bool sendOBDQuery(uint8_t pid);
bool sendDTCQuery();
