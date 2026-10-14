#define ARDUINO_USB_CDC_ON_BOOT 1
#define USB_SERIAL_JTAG
#define XCELA_FIRMWARE_VERSION "R19"
#define XCELA_FIRMWARE_NAME "MALKON XCELA FIRMWARE R19.2.5 TI1R5 RECOVERY CONTROLLER"
#define TINY_GSM_MODEM_A7670
#define TINY_GSM_MODEM_A7672X
#define TINY_GSM_RX_BUFFER          1024 // Set RX buffer to 1Kb    
#define MODEM_GPS_ENABLE_GPIO       (-1)
#define FORMAT_SPIFFS_IF_FAILED false
// #define DEVELOPMENT

// Uncomment ONLY ONE of these to define your board version:
//#define XCELAV1    //2023 LIMITER VERSION  
//#define XCELAV3A   //2025 LIMITER VERSION1  //BLUE NEOGPS ON PCB TOP
//#define XCELAV3B   //2025 LIMITER VERSION2  //BLUE NEOGPS ON PCB BOTTOM
#define XCELAV4      //2025 TRACKER LIMITER VERSION1

#if defined(XCELAV1)     //2023 LIMITER VERSION - ALL ALUMINUM CASING
  #define BOARD "1"
  #define RXD2 21
  #define TXD2 2
  #define RELAY_PIN           5
  #define BUZZER_PIN          9    

#elif defined(XCELAV3A)   //2025 LIMITER VERSION1  //GPS ON PCB TOP - ABS
  #define BOARD "2"
  #define RXD2 17
  #define TXD2 18
  #define RELAY_PIN           6
  #define BUZZER_PIN          9

#elif defined(XCELAV3B)  //2025 LIMITER VERSION2  //GPS ON PCB BOTTOM - ABS
  #define BOARD "3"
  #define RXD2 18
  #define TXD2 17
  #define RELAY_PIN           6
  #define BUZZER_PIN          9

#elif defined(XCELAV4)  //2025 TRACKER LIMITER VERSION1  - ABS
  #define BOARD "4"
  #define TEMPER_PROOF_PIN    2         // 6,42 interuppt, 40 interrupt, 12 INTERRUPT, 39 interrupt
  #define ADC_PIN             4         // Internal Battery pin  voltage divider
  #define ADC_PIN_2           5         // External Battery pin voltage divider
  #define ADC_PIN_1           6         // Ignition pin voltage divider
  #define FUEL_SENSOR_PIN     7         // ADC pin5 connected to the fuel sensor
  #define ACCIDENT_ALERT_PIN  8         // UNUSED 0 - PULL DOWN
  #define UNUSED1             9         // UNUSED 1 - PULL UP
  #define PANIC_BUTTON_PIN    10        // 42
  
  #define BUZZER_PIN          11        //  
  #define RELAY_PIN           12        // RELAY PIN
  #define UNUSED2             13 
  #define UNUSED3             14 
  
  #define GSM_RX_PIN          15
  #define GSM_TX_PIN          16
  #define GSM_PWR_KEY         21 
  
  #define TXD2                17 //GPS  
  #define RXD2                18 //GPS
 
  //8,9 pot divider
  //LDR sensor
#else
  // ✅ FIXED: Default fallback if no board is defined
  #define BOARD "0"
  #define RXD2 18
  #define TXD2 17
  #define RELAY_PIN           5
  #define RELAY_PIN           6
  #define BUZZER_PIN          9
#endif

#include <SPI.h>
#include <GxEPD2_3C.h>
#include <Fonts/FreeMonoBold9pt7b.h>
#include <Fonts/FreeMono9pt7b.h>

//E-PAPER DISPLAY
#define SDI      35
#define SCLK     36
#define EPD_CS   37
#define EPD_DC   38
#define EPD_RST  39
#define EPD_BUSY 40


GxEPD2_3C<GxEPD2_213_Z98c, GxEPD2_213_Z98c::HEIGHT> display(GxEPD2_213_Z98c(EPD_CS, EPD_DC, EPD_RST, EPD_BUSY));

// Explicit declaration for Arduino 1.8.19 / ESP32 core 2.0.11 sketch preprocessing.
void ePaper();

#include "esp_system.h"
#include "esp_task_wdt.h"
#include "esp_heap_caps.h"
#include "esp_attr.h"
// R19.2.6: Brownout-reset suppression. The A7670 modem draws a large current
// spike during power-key assertion and modem.restart(). On a shared supply this
// causes the ESP32 brownout detector to trigger an unplanned reset (reset_code=6),
// which then fires the startup buzzer and restarts tracking from scratch.
// Disabling the brownout detector is standard practice for ESP32+GSM designs.
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"
#include "freertos/stream_buffer.h"
#include "freertos/semphr.h"
#include "TI1R3_Types.h"
#include "Sim_Recovery.h"

// ---------- Configuration ----------
#define WATCHDOG_TIMEOUT 360  

#include <WiFi.h>
#include <WiFiClient.h>
#include <WebServer.h>
#include <TinyGsmClient.h>
#include <Wire.h> 
#include <ArduinoJson.h>
#include <CustomJWT.h>
//#include "ESPAsyncWebServer.h"
#include <stdint.h>   // Include header for uint32_t
#include <stddef.h>
#include "R18_TrackingBreadcrumb.h"
#include <string.h>
#include <TinyGPSPlus.h>
//#include "FS.h"
#include "SPIFFS.h"
#include <ArduinoHttpClient.h>
#include <EEPROM.h> //##1
#include "TickTwo.h"
#include <Update.h>

//FOR SPEED LIMITNG
#include <EEPROM.h>
#include <Arduino_JSON.h>
#include <CRC32.h>

//
#ifdef DEVELOPMENT
  #define SERVER "69df-41-175-110-85.ngrok-free.app"
#else
  # define SERVER "inferth-mapping.up.railway.app"
#endif

#define SERVER_PORT 443

// Buzzer control pin

#define ADC_RESOLUTION 4096  // 12-bit resolution of ESP32 ADC
#define ADC_REF_VOLTAGE 3.3  // Reference voltage for ADC
#define R1 1000.0           // Resistor R1 value in ohms
#define R2 10000.0  

#define R3 1000.0           // FUEL
#define R4 10000.0  

#define R5 1000.0           // EXT BATTERY
#define R6 10000.0  

#define ADC_THRESHOLD 2.5  
#define RESISTOR_RATIO 11.0  // Voltage divider ratio (1:10) for external power

#define SENSOR_MAX_VOLTAGE 5  // Max voltage output from the sensor
#define TANK_HEIGHT 2.94     // Tank height in cm
#define TANK_AREA 1     // Tank cross-sectional area in cm^2

// ================== EEPROM ADDRESS MAP ===================
#define EEPROM_SERIAL 0         // 16 bytes (0-15)
#define EEPROM_VEHICLE_ID 16    // 32 bytes (16-47)  // vehicleID = SSID
#define EEPROM_COMPANY 48       // 32 bytes (48-79)   // installingCompany = AGENT
#define EEPROM_INSTALLER_NAME 80 // 32 bytes (80-111) // installerName = INSTALLER
#define EEPROM_INSTALL_DATE 112 // 32 bytes (112-143)
#define EEPROM_CHASSIS 144      // 32 bytes (144-175)

// SIM 1 Configuration
#define EEPROM_SIM1_NUM 176     // 32 bytes (176-207)
#define EEPROM_APN1 208         // 32 bytes (208-239)  // apn1 = APN
#define EEPROM_APN1_USER 240    // 32 bytes (240-271)  // apnUser1 = APN_U
#define EEPROM_APN1_PASS 272    // 32 bytes (272-303)  // apnPass1 = APN_P

// SIM 2 Configuration
#define EEPROM_SIM2_NUM 304     // 32 bytes (304-335)
#define EEPROM_APN2 336         // 32 bytes (336-367)
#define EEPROM_APN2_USER 368    // 32 bytes (368-399)
#define EEPROM_APN2_PASS 400    // 32 bytes (400-431)

// Other Settings
#define EEPROM_OWNER_PHONE 432  // 32 bytes (432-463) // ownerPhone = OWNER_NUMBER
#define EEPROM_SPEED_LIMIT 464  // 8 bytes (464-471)  // speedLimit = LIMIT
#define EEPROM_MIN_SPEED 472    // 8 bytes (472-479)  // minSpeed = MIN_SPEED
#define EEPROM_CONFIG_BOX 480   // 32 bytes (480-511)

#define EEPROM_SIZE 512

// Instantiate TinyGsmClientSecure for HTTPS
TinyGsm modem(Serial1);
TinyGsmClientSecure client(modem);
HttpClient http(client, SERVER, SERVER_PORT);

// Instantiate TinyGPS
TinyGPSPlus gps;
TinyGPSPlus neoGPS;
// Dedicated parser copies used only by the continuously serviced R11 filter.
// The existing gps/neoGPS objects remain available to the tracker and limiter.
TinyGPSPlus r11A7670GPS;
TinyGPSPlus r11NeoGPS;
// R19 diagnostic hook used by the GNSS filter for persistent issue breadcrumbs.
void r19LogGnssIssueEvent(const char* event, const char* detail);
#define R19_GNSS_ISSUE_HOOK(event, detail) r19LogGnssIssueEvent((event), (detail))
#include "GPS_Filter_R11.h"
#include "Route_Decision.h"
#include "GNSS_GSV_Diagnostics.h"

// R19.1 GNSS production diagnostics: keep expensive forensic diagnostics
// available in source, but do not run them automatically during normal boot.
constexpr bool GNSS_DIAGNOSTIC_BOOT_DUMP_ENABLED = false;
constexpr bool A7670_FULL_BOOT_DIAGNOSTIC_ENABLED = false;
#include "A7670_NMEA_Diagnostics.h"

// R14 controlled-restart GNSS continuity. This RTC-retained block is written
// only immediately before a deliberate health/preventive ESP.restart(). It is
// consumed once on the next boot, so power loss or unrelated resets still use
// the normal full GNSS acquisition path.
struct R14RetainedGnssState {
  uint32_t magic;
  uint32_t version;
  double confirmedLat;
  double confirmedLon;
  double envelopeLat;
  double envelopeLon;
  uint8_t envelopeEstablished;
  uint8_t trusted;
  uint32_t checksum;
};

constexpr uint32_t R14_RETAINED_GNSS_MAGIC = 0x58313447UL; // "X14G"
constexpr uint32_t R14_RETAINED_GNSS_VERSION = 2UL; // R18.2 adds WORKING/HOLDOVER trust class
__NOINIT_ATTR R14RetainedGnssState r14RetainedGnssState;

TaskHandle_t task_gps_acquisition = nullptr;
StreamBufferHandle_t neoLimiterStream = nullptr;
SemaphoreHandle_t r11A7670ParserMutex = nullptr;
volatile uint32_t neoLimiterStreamDroppedBytes = 0;
const size_t NEO_LIMITER_STREAM_BUFFER_SIZE = 32768;

// R17D2 health supervisor.  loop1 owns network/server work and is the task
// subscribed to the ESP task watchdog.  The dedicated GPS task remains alive
// even if a lower-level modem/HTTP call traps loop1, so it can report the exact
// stalled stage and perform a controlled restart before the 360 s panic WDT.
enum HttpCriticalStage : uint8_t {
  HTTP_STAGE_NONE = 0,
  HTTP_STAGE_NETWORK_CHECK = 1,
  HTTP_STAGE_GPRS_CHECK = 2,
  HTTP_STAGE_SIGNAL_QUALITY = 3,
  HTTP_STAGE_SOCKET_CONNECT = 4,
  HTTP_STAGE_REQUEST_SEND = 5,
  HTTP_STAGE_RESPONSE_STATUS = 6,
  HTTP_STAGE_RESPONSE_BODY = 7
};
volatile uint32_t loop1HeartbeatMs = 0;
volatile uint32_t httpCriticalStageStartedAt = 0;
volatile uint8_t httpCriticalStage = HTTP_STAGE_NONE;
// R19.2.3: A 90 s loop1 heartbeat gap is diagnostic only. Field logs proved
// that bounded SIM switching/modem recovery can legitimately keep loop1 inside
// network recovery longer than 90 s while the dedicated GPS task remains healthy.
// Rebooting in that situation created a self-sustaining reset loop. A genuinely
// dead loop1 is still protected by the existing 360 s ESP task watchdog.
// TI1R2 keeps all HTTP/network stalls in communication recovery. The GPS task
// reports a prolonged response-status wait but never restarts the ESP for it.
const uint32_t LOOP1_STALL_DIAGNOSTIC_MS = 90000UL;
const uint32_t LOOP1_STALL_DIAGNOSTIC_REPEAT_MS = 60000UL;
const uint32_t HTTP_RESPONSE_STATUS_STALL_DIAGNOSTIC_MS = 120000UL;
static bool loop1StallDiagnosticActive = false;
static uint32_t lastLoop1StallDiagnosticAt = 0;
static uint32_t lastHttpStallDiagnosticAt = 0;
String geofenceState;

// Global variable to manually track active SIM
int currentActiveSIM = 0;  // 0 = unknown, 1 = SIM 1, 2 = SIM 2
int lastKnownGoodSIM = 0;
bool sim1Available = false;
bool sim2Available = false;
bool hadBothSimsOnBoot = false;

float extBatteryVoltage;
// GPS DATA VARIABLES for Web Server
String gpsTime = "N/A";
String gpsLatitude = "N/A";
String gpsLongitude = "N/A";
String gpsSpeed = "N/A";
String gpsAltitude = "N/A";
String gpsSatellites = "N/A";
String gpsHDOP = "N/A";
String gpsStatus = "No GPS";
unsigned long lastGPSUpdate = 0;
const int maxUploadLines = 10;

String vehicleID, installingCompany, installerName;
String installDay, installMonth, installYear;
String simNumber1, apn1, apnUser1, apnPass1;
String simNumber2, apn2, apnUser2, apnPass2;
String ownerPhone, speedLimit;
String configBox;

// ---------------- ADMIN CREDENTIALS ----------------
const char* ADMIN_USER = "admin";


// Session management
bool isAuthenticated = false;
unsigned long authTimeout = 0;
const unsigned long AUTH_DURATION = 300000; // 5 minutes
String successMessage = "";

int postCount; //GNSS data stagnation counter
String post_bodyOld;
// Create AsyncWebServer object on port 80
WebServer server(80);
boolean configBtn;

int sendFailCount;
 
bool is_location_valid;  // A7670E GNSS
bool is_location_valid2; //NEO GPS

int gpsCount;
bool gprs_connected ;
int recharge;

//E-PAPER DISPLAY
unsigned long lastUpdateTime = 0;
const unsigned long updateInterval = 120000;
unsigned long currentTime;

//For Timing
unsigned long int t1 = 240000;
unsigned long int t;

// I/O pins
//#define RELAY_PIN           12
//#define RELAY_PIN           5
//#define BUZZER_PIN          9

//File Data Logging
int sats = 5;
int hours;
String spd, lati, lngi;
String oldLati, oldLngi;
String datetime;
String Ndatetime;
String Ndate;
String Ntime;
String oldDatetime;
String dataString;
long lastDoTime = 0;

const char* fileName1 = "/data.csv";
const char* fileName2 = "/offlineData.csv";
const char* offlineDataMetaFileName = "/offlineData.meta";
const char* fileName3 = "/violations.csv";

int rowCount;
int newRows;
int newEntries;

enum StorageProfile {
  SAZ_LOG_STORAGE,
  OFFLINE_PRIORITY_STORAGE
};

StorageProfile storageProfile = OFFLINE_PRIORITY_STORAGE;

//int rowsTotal1 = 5000; //10500 //12000 //15000
float rowsLimit1 = 6000;
int maxSize1 = 500000; //maxFile size for data.csv where speed limiter data is stored

float rowsLimit2 = 1400;
int maxSize2 = 200000; //maxFile size for data.csv where speed limiter data is stored

float rowsLimit3 = 500;
int maxSize3 = 50000; //maxFile size for data.csv where speed limiter data is stored

unsigned long offlineTelemetrySampleIntervalMs = 150000UL;
unsigned long offlineViolationRepeatIntervalMs = 180000UL;
const unsigned long offlineMovingShortOutageIntervalMs = 60000UL;
const unsigned long offlineMovingMediumOutageIntervalMs = 120000UL;
const unsigned long offlineMovingLongOutageIntervalMs = 240000UL;
const unsigned long offlineMovingExtendedOutageIntervalMs = 360000UL;
const unsigned long offlineStationaryShortOutageIntervalMs = 600000UL;
const unsigned long offlineStationaryMediumOutageIntervalMs = 900000UL;
const unsigned long offlineStationaryLongOutageIntervalMs = 1200000UL;
const unsigned long offlineStationaryExtendedOutageIntervalMs = 1800000UL;
const unsigned long offlineShortOutageWindowMs = 7200000UL;
const unsigned long offlineMediumOutageWindowMs = 43200000UL;
const unsigned long offlineLongOutageWindowMs = 172800000UL;
const unsigned long offlineHighPressureHeartbeatMs = 3600000UL;

void applyStorageProfile() {
  if (storageProfile == OFFLINE_PRIORITY_STORAGE) {
    rowsLimit1 = 500;
    maxSize1 = 50000;
    rowsLimit2 = 5200;
    maxSize2 = 650000;
    rowsLimit3 = 1000;
    maxSize3 = 100000;
  } else {
    rowsLimit1 = 6000;
    maxSize1 = 500000;
    rowsLimit2 = 1400;
    maxSize2 = 200000;
    rowsLimit3 = 500;
    maxSize3 = 50000;
  }
}

// Speed thresholds
float SPEED_LIMIT = 80;       // Speed limit in km/hr
float speedKmph;

long zeroOne = 0, zeroTwo = 1001;
int sCount, sCount2;

//flash memory values
String dateOfFitting = "";
String ownerNumber; //(67, 78)
String serialNumber; //(79,99);
String chassisNumber;//(100,120);

//New Variables
String  installer;
String agent;
String ssid;

float warnPercent = 95;
int minSpeed = 20;
int setting = 0;


uint32_t checkChecksum(const String& input);

int count0, count1;
bool Run = false;
bool Run1 = false;

unsigned long averageOnTime;    // Total cumulative on time
unsigned long averageOffTime;   // Total cumulative off time
//int minSpeed = 20;
//int setting = 0;
float limpTrigger1;
float limpTrigger2;

int count = 0;      //for warning buzzer delays and flags
bool flag1 = false; //toavoid warning when decreasing speed

//Server
//String ssid = "Vehicle ID 2"; //FLASH MEM
String password = ""; //FLASH MEM

// Initialize JWT Secret. jwt-secret.txt is 72 chars; reserve one byte for '\0'.
char jwt_secret[73] = "";
String jwt_token;

String dummyValue;

//GPRS SETTINGS
String apn = "econet.net"; // Default for Zimbabwe Econet; updated by selectActiveAPN()
String apn_u = "";
String apn_p = "";

#ifdef DEVELOPMENT
  String number_plate = "AAA-0000";
#else
  String number_plate = "ABC1234";
#endif
       
/*
* The following flags are use to avoid recording the same violation multiple times
* They are set true when a violation is recorded and reset to false when the vehicle
* moves out of the violation state
*/
enum ViolationFlagState {
  NO_VIOLATION,
  VIOLATION_AWAITING_SENDING,
  VIOLATION_SENT,
};

ViolationFlagState geofenceViolationState = NO_VIOLATION;

TrackingOutageState trackingOutage = {false, 0, 0, false, 0};
PdpState pdpState = PDP_UNKNOWN;
SemaphoreHandle_t offlineQueueMutex = nullptr;
ViolationFlagState speedViolationState = NO_VIOLATION;
ViolationFlagState temperViolationState = NO_VIOLATION;

volatile bool tamperInterruptPending = false;
volatile bool accidentInterruptPending = false;
volatile bool panicInterruptPending = false;

bool shouldSendAccidentAlert = false;
bool shouldSendPanicAlert = false;

bool speedLimiterRelayRequest = false;
bool geofenceRelayRequest = false;
bool gpsLossRelayRequest = false;

unsigned long distance_between ;

// GSM Modem
String modem_name;
String modem_info = "DEFAULT";
String ccid;
String imei;
String imsi;
String operator_name;
String ipAddress;
String vehicle_state = "STATIONARY";
int gps_satellites = 0;
float gps_hdop = 0.0;
float gps_lat = 0;
float gps_lon = 0;
//String GPS_LAT;
//String GPS_LON;

float lastlat;
float lastlon;

int gps_age = 0;
int gps_day = 0;
int gps_month = 0;
int gps_year = 0;
int gps_hour = 0;
int gps_minute = 0;
int gps_second = 0;

String time_from = "";
String time_to = "";
int gps_altitude = 0;
float gps_course = -1;
int gps_speed = 0;
int battery_percentage = 0;
int fuel_level = 0;
bool ignition = false;

// Auto-select APN according to active SIM and network operator
void selectActiveAPN() {
  String candidateApn = "";
  String candidateUser = "";
  String candidatePass = "";

  if (currentActiveSIM == 1 && apn1.length() > 0) {
    candidateApn = apn1; candidateUser = apnUser1; candidatePass = apnPass1;
  } else if (currentActiveSIM == 2 && apn2.length() > 0) {
    candidateApn = apn2; candidateUser = apnUser2; candidatePass = apnPass2;
  } else if (apn1.length() > 0) {
    candidateApn = apn1; candidateUser = apnUser1; candidatePass = apnPass1;
  } else if (apn2.length() > 0) {
    candidateApn = apn2; candidateUser = apnUser2; candidatePass = apnPass2;
  }

  // Auto-detect based on operator or IMSI if EEPROM was blank
  if (candidateApn.length() == 0) {
    String op = operator_name;
    op.toUpperCase();
    if (op.indexOf("NETONE") >= 0 || imsi.startsWith("64801")) {
      candidateApn = "internet.netone";
    } else if (op.indexOf("TELECEL") >= 0 || imsi.startsWith("64803")) {
      candidateApn = "internet.telecel";
    } else {
      candidateApn = "econet.net";
    }
  }

  apn = candidateApn;
  apn_u = candidateUser;
  apn_p = candidatePass;
}

bool netSig = 0;


int Ngps_satellites = 0;
float Ngps_hdop = 0.0;
float Ngps_lat = 0;
float Ngps_lon = 0;

int Ngps_age = 0;
int Ngps_day = 0;
int Ngps_month = 0;
int Ngps_year = 0;
int Ngps_hour = 0;
int Ngps_minute = 0;
int Ngps_second = 0;

int Ngps_altitude = 0;
float Ngps_course = -1;
int Ngps_speed = 0;

// Geofence
String geofenceId = "null";
unsigned long geofencePolySides = 0;

// Engine Lock Status
bool isEngineLocked;

void sendTrackingData();
void uploadOfflineData();
void sampleGpsTrackingDataOnly();
void serviceMovingBreadcrumbCaptureFromGpsTask();
bool applyR11ProcessedGpsToTracker();
int reportedDualGnssSatelliteCount();
void refreshOfflineQueueFormatAfterRewrite(int remainingRows);
void setScheduledRestartCriticalWork(bool active);
static void getCommandFromServer();
void setup1();
void loop1();
void onTemperHandler();
void onAccidentHandler();
void onPanicHandler();
void loadSerialFromEEPROM();
void loadConfigFromEEPROM();
void selectActiveAPN();
void initializeGSMModule();
void updateActiveSIMTracking();
void discoverSIMSlotsAtBoot();
bool isSIMCardPresent();
void switchSIM();
void configureA7670GpsOutput();
// Explicit cross-tab declarations for Arduino 1.8.19 sketch preprocessing.
bool ensureA7670GnssPowerOn(const char* reason);
void diagnoseA7670GnssState(const char* reason, bool restoreNmea);
void serviceGnssDiagnosticCaptureFromGpsTask();
void serviceGnssDiagnosticStorage();
void serviceRouteDecisionFromGpsTask();
uint32_t consumeRouteLiveSendMask();
uint8_t lastHttpFailurePhase();
void dumpGnssDiagnosticLogsOnBoot();
void serviceLbsFallback();
bool getLbsFallbackLocation(float& lat, float& lon, float& accuracyM, uint32_t& ageMs);
bool hasSendableLbsFallback();
bool getLbsFallbackUtcDate(String& dateOut, uint32_t& ageMs);
const char* lbsFallbackStateTag();
void noteGnssDiagnosticPayload(float lat, float lon, int speed, int satellites, int hdop, const char* source);
void startGnssProtectionWindow();
bool modemGnssWarmupActive();
void runServer();
void recoverOfflineQueueRewriteArtifacts();
void writeDataToFile(const char * theFile, String theData);
bool safeTrimCsvToLimits(const char* fileName, int maxBytes, int maxRows, int headerRowsToKeep);
uint32_t currentReliableEpoch(bool forcePersist);
void initializeTrackingBreadcrumbStorage();
void loadPersistedGpsClock();
void setupWatchdog();
static bool persistRetainedGnssStateForControlledRestart();
void deviceConfig();
void warning();
void doThisAtEvery(int ms);
void kickWatchdog();
void checkFuel();
void checkIgnition();
void internalBattery();
void externalBattery();
void sendViolations();
void sendAlerts();
bool neoGpsSpeedIsReliable();

// R19.2.5 ARDUINO 1.8.19 COMPILE SAFEGUARD - DO NOT REGRESS:
// These debounce constants must be declared before processPendingInterrupts()
// because that function is defined earlier in the sketch than the telemetry
// timing block. Keep the values identical to R19.2.4; this is an ordering-only
// compile correction with no behavior change.
const unsigned long ldrTamperDebounceMs = 300UL;
const unsigned long discreteInputDebounceMs = 80UL;

void processPendingInterrupts();
void applyRelayState();
void setServerEngineLock(bool locked);
void setSpeedLimiterRelayRequest(bool locked);
void setGeofenceRelayRequest(bool locked);
void setGpsLossRelayRequest(bool locked);
void loadGeofenceCache();
String adminPassword();
static int limiterNeoSerialAvailable();
static int limiterNeoSerialRead();
static void startGpsAcquisitionTask();
static void createJWT();
bool vehicleIdentityConfigured();
bool applyConfiguredVehicleIdentity(bool regenerateJwt, const char* reason);

String adminPassword() {
  if (serialNumber.length() >= 8 && serialNumber != "UNSET") {
    return serialNumber.substring(0, 8);
  }
  return "1234ABCD";
}

void applyRelayState() {
  bool relayShouldLock = isEngineLocked || speedLimiterRelayRequest || geofenceRelayRequest || gpsLossRelayRequest;
  digitalWrite(RELAY_PIN, relayShouldLock ? HIGH : LOW);
}

void setServerEngineLock(bool locked) {
  isEngineLocked = locked;
  applyRelayState();
}

void setSpeedLimiterRelayRequest(bool locked) {
  speedLimiterRelayRequest = locked;
  applyRelayState();
}

void setGeofenceRelayRequest(bool locked) {
  geofenceRelayRequest = locked;
  applyRelayState();
}

void setGpsLossRelayRequest(bool locked) {
  gpsLossRelayRequest = locked;
  applyRelayState();
}

void processPendingInterrupts() {
  // R19.2.4 LDR SAFEGUARD - DO NOT REGRESS:
  // GPIO2 is the V4 LDR/light-tamper input. Do not enable an internal pull-up
  // or use a CHANGE interrupt on this analogue-capable sensor input.
  // User-defined polarity is authoritative: HIGH = light ON / no tamper;
  // LOW = light OFF / tamper. We use the GPIO logic state for that exact
  // polarity and sample ADC millivolts only for diagnostics, avoiding an
  // invented analogue threshold that has not been calibrated for this board.
  static bool ldrInitialized = false;
  static bool ldrCandidateTamper = false;
  static bool ldrStableTamper = false;
  static unsigned long ldrCandidateSince = 0;
  bool ldrRawTamper = digitalRead(TEMPER_PROOF_PIN) == LOW;
  unsigned long now = millis();

  if (!ldrInitialized) {
    ldrInitialized = true;
    ldrCandidateTamper = ldrRawTamper;
    ldrCandidateSince = now;
  } else {
    if (ldrRawTamper != ldrCandidateTamper) {
      ldrCandidateTamper = ldrRawTamper;
      ldrCandidateSince = now;
    }

    if (ldrCandidateTamper != ldrStableTamper &&
        now - ldrCandidateSince >= ldrTamperDebounceMs) {
      ldrStableTamper = ldrCandidateTamper;
      uint32_t ldrMv = analogReadMilliVolts(TEMPER_PROOF_PIN);
      Serial.print("[LDR] GPIO2 stable state=");
      Serial.print(ldrStableTamper ? "LOW" : "HIGH");
      Serial.print(" adc_mv=");
      Serial.print(ldrMv);
      Serial.print(" tamper=");
      Serial.println(ldrStableTamper ? "YES" : "NO");

      if (ldrStableTamper) {
        if (temperViolationState == NO_VIOLATION) {
          temperViolationState = VIOLATION_AWAITING_SENDING;
        }
      } else if (temperViolationState == VIOLATION_SENT) {
        temperViolationState = NO_VIOLATION;
      }
    }
  }

  // GPIO8 has an onboard pull-down. A valid event is therefore a stable HIGH
  // assertion, not either edge. The ISR only marks a RISING candidate; loop
  // code verifies that the input is still asserted after debounce.
  static bool accidentDebounceActive = false;
  static unsigned long accidentCandidateSince = 0;
  if (accidentInterruptPending) {
    accidentInterruptPending = false;
    accidentDebounceActive = true;
    accidentCandidateSince = now;
  }
  if (accidentDebounceActive && now - accidentCandidateSince >= discreteInputDebounceMs) {
    if (digitalRead(ACCIDENT_ALERT_PIN) == HIGH) {
      shouldSendAccidentAlert = true;
    }
    accidentDebounceActive = false;
  }

  // GPIO10 is the protected push/service/panic input. The measured V4 idle
  // state is LOW, so only a stable HIGH assertion creates an SOS event. Do not
  // restore INPUT_PULLUP/CHANGE behaviour: it caused press+release triggers.
  static bool panicDebounceActive = false;
  static unsigned long panicCandidateSince = 0;
  if (panicInterruptPending) {
    panicInterruptPending = false;
    panicDebounceActive = true;
    panicCandidateSince = now;
  }
  if (panicDebounceActive && now - panicCandidateSince >= discreteInputDebounceMs) {
    if (digitalRead(PANIC_BUTTON_PIN) == HIGH) {
      shouldSendPanicAlert = true;
    }
    panicDebounceActive = false;
  }
}

// Serial2 has one physical owner: gpsAcquisitionTask().
// Every NEO byte is fanned out to the dedicated R11 parser immediately and
// copied into a stream buffer for the existing limiter neoGPS parser.
// This preserves raw NEO data for the limiter while preventing two tasks from
// consuming the same UART.
static int limiterNeoSerialAvailable() {
  if (neoLimiterStream != nullptr) {
    return (int)xStreamBufferBytesAvailable(neoLimiterStream);
  }
  // Fail-safe only if the acquisition task could not be created.
  return Serial2.available();
}

static int limiterNeoSerialRead() {
  if (neoLimiterStream != nullptr) {
    uint8_t byteValue = 0;
    size_t received = xStreamBufferReceive(neoLimiterStream, &byteValue, 1, 0);
    return received == 1 ? (int)byteValue : -1;
  }
  // Fail-safe only if the acquisition task could not be created.
  return Serial2.read();
}

static void feedA7670GpsParsersAvailable() {
  bool mutexHeld = false;
  if (r11A7670ParserMutex != nullptr) {
    mutexHeld = xSemaphoreTake(r11A7670ParserMutex, portMAX_DELAY) == pdTRUE;
  }

  while (Serial1.available()) {
    int ch = Serial1.read();
    gps.encode(ch);
    r11A7670GPS.encode(ch);
    GsvDiagnostics::feedA7670((char)ch);
    A7670NmeaDiag::feed((char)ch);
  }

  if (mutexHeld) {
    xSemaphoreGive(r11A7670ParserMutex);
  }

  // Diagnostic printing happens only after the R11 parser mutex is released.
  GsvDiagnostics::serviceA7670();
  A7670NmeaDiag::service();
}

static const char* httpCriticalStageName(uint8_t stage) {
  switch (stage) {
    case HTTP_STAGE_NETWORK_CHECK: return "NETWORK_CHECK";
    case HTTP_STAGE_GPRS_CHECK: return "GPRS_CHECK";
    case HTTP_STAGE_SIGNAL_QUALITY: return "SIGNAL_QUALITY";
    case HTTP_STAGE_SOCKET_CONNECT: return "SOCKET_CONNECT";
    case HTTP_STAGE_REQUEST_SEND: return "REQUEST_SEND";
    case HTTP_STAGE_RESPONSE_STATUS: return "RESPONSE_STATUS";
    case HTTP_STAGE_RESPONSE_BODY: return "RESPONSE_BODY";
    default: return "NONE";
  }
}

void setHttpCriticalStage(uint8_t stage) {
  httpCriticalStage = stage;
  httpCriticalStageStartedAt = (stage == HTTP_STAGE_NONE) ? 0 : millis();
}

void persistRestartDiagnostic(const char* category, const char* detail) {
  const char* restartFile = "/restart-last.json";
  const char* restartTempFile = "/restart-last.tmp";
  JsonDocument doc;
  doc["planned_category"] = category ? category : "UNKNOWN";
  doc["planned_detail"] = detail ? detail : "UNKNOWN";
  doc["requested_uptime_ms"] = millis();
  doc["free_heap"] = ESP.getFreeHeap();
  doc["minimum_free_heap"] = ESP.getMinFreeHeap();
  doc["largest_free_block"] = heap_caps_get_largest_free_block(MALLOC_CAP_8BIT);

  if (SPIFFS.exists(restartTempFile)) SPIFFS.remove(restartTempFile);
  File output = SPIFFS.open(restartTempFile, "w");
  if (!output) {
    Serial.println("EVENT,RESTART_DIAGNOSTIC_WRITE_FAILED");
    return;
  }
  serializeJson(doc, output);
  output.close();
  if (SPIFFS.exists(restartFile)) SPIFFS.remove(restartFile);
  if (!SPIFFS.rename(restartTempFile, restartFile)) {
    Serial.println("EVENT,RESTART_DIAGNOSTIC_INSTALL_FAILED");
  }
}

void recordAndDisplayBootRestartDiagnostic() {
  const char* restartFile = "/restart-last.json";
  JsonDocument doc;
  if (SPIFFS.exists(restartFile)) {
    File input = SPIFFS.open(restartFile, "r");
    if (input) {
      deserializeJson(doc, input);
      input.close();
    }
  }

  esp_reset_reason_t resetReason = esp_reset_reason();
  String plannedCategory = doc["planned_category"] | "NONE";
  String plannedDetail = doc["planned_detail"] | "NONE";
  bool consumedPlannedRestart = resetReason == ESP_RST_SW && plannedCategory != "NONE";
  doc["last_restart_category"] = consumedPlannedRestart ? plannedCategory : "UNPLANNED_SYSTEM";
  doc["last_restart_detail"] = consumedPlannedRestart ? plannedDetail : "RESET_CAUSE_AT_BOOT";
  doc["observed_reset_code"] = (int)resetReason;
  doc["observed_boot_uptime_ms"] = millis();
  doc["observed_epoch"] = currentReliableEpoch(false);
  doc["planned_category"] = "NONE";
  doc["planned_detail"] = "NONE";

  Serial.print("[BOOT-RESET] reset_code=");
  Serial.print((int)resetReason);
  Serial.print(" category=");
  Serial.print(doc["last_restart_category"] | "UNPLANNED_SYSTEM");
  Serial.print(" detail=");
  Serial.println(doc["last_restart_detail"] | "RESET_CAUSE_AT_BOOT");

  File output = SPIFFS.open(restartFile, "w");
  if (output) {
    serializeJson(doc, output);
    output.close();
  }
}

static void monitorLoop1AndHttpStall() {
  if (!Run1 || loop1HeartbeatMs == 0) return;

  uint32_t now = millis();
  uint8_t stage = httpCriticalStage;
  uint32_t stageStarted = httpCriticalStageStartedAt;

  if (stage == HTTP_STAGE_RESPONSE_STATUS && stageStarted != 0 &&
      (uint32_t)(now - stageStarted) >= HTTP_RESPONSE_STATUS_STALL_DIAGNOSTIC_MS &&
      (lastHttpStallDiagnosticAt == 0 ||
       (uint32_t)(now - lastHttpStallDiagnosticAt) >= LOOP1_STALL_DIAGNOSTIC_REPEAT_MS)) {
    lastHttpStallDiagnosticAt = now;
    Serial.print("EVENT,HTTP_RESPONSE_STATUS_STALL,STALLED_MS,");
    Serial.print(now - stageStarted);
    Serial.println(",ACTION,COMMUNICATION_RECOVERY_ONLY");
  } else if (stage != HTTP_STAGE_RESPONSE_STATUS) {
    lastHttpStallDiagnosticAt = 0;
  }

  uint32_t heartbeatAge = now - loop1HeartbeatMs;

  // R19.2.3 FALSE-RESET SAFETY - DO NOT REGRESS:
  // The SIM/network recovery path contains bounded modem operations, slot
  // switching, CPIN checks and settle delays. These can legitimately hold
  // loop1 longer than 90 s while the GPS task continues normally. R17D2 treated
  // that expected delay as a dead loop and deliberately called ESP.restart(),
  // producing the repeated RTC_SW_CPU_RST sequence seen in the field.
  //
  // HTTP/network stage stalls and a stale generic heartbeat are diagnostic only.
  // The bounded transport calls and existing modem/SIM recovery own recovery.
  if (heartbeatAge >= LOOP1_STALL_DIAGNOSTIC_MS) {
    if (!loop1StallDiagnosticActive ||
        (uint32_t)(now - lastLoop1StallDiagnosticAt) >= LOOP1_STALL_DIAGNOSTIC_REPEAT_MS) {
      loop1StallDiagnosticActive = true;
      lastLoop1StallDiagnosticAt = now;
      Serial.println();
      Serial.println("[HEALTH] loop1 heartbeat delayed; automatic generic restart SUPPRESSED");
      Serial.print("[HEALTH] reason=LOOP1_STALL_DIAGNOSTIC stalled_ms=");
      Serial.print(heartbeatAge);
      Serial.print(" http_stage=");
      Serial.println(httpCriticalStageName(httpCriticalStage));
      Serial.println("[HEALTH] Known SIM/modem/network work is allowed to finish; 360 s task watchdog remains last-resort protection");
    }
    return;
  }

  if (loop1StallDiagnosticActive) {
    loop1StallDiagnosticActive = false;
    lastLoop1StallDiagnosticAt = 0;
    Serial.println("[HEALTH] loop1 heartbeat recovered without ESP restart");
  }
}

static void gpsAcquisitionTask(void* pvParameters) {
  (void)pvParameters;

  for (;;) {
    bool receivedNeoBytes = false;

    while (Serial2.available() > 0) {
      int raw = Serial2.read();
      if (raw < 0) {
        break;
      }

      char ch = (char)raw;
      r11NeoGPS.encode(ch);
      GsvDiagnostics::feedNeo(ch);
      receivedNeoBytes = true;

      if (neoLimiterStream != nullptr) {
        uint8_t byteValue = (uint8_t)ch;
        if (xStreamBufferSend(neoLimiterStream, &byteValue, 1, 0) != 1) {
          neoLimiterStreamDroppedBytes++;
        }
      }
    }

    // R11 is processed only here. The short mutex prevents it from reading
    // the dedicated A7670 parser while loop1 is completing an NMEA update.
    if (r11A7670ParserMutex == nullptr ||
        xSemaphoreTake(r11A7670ParserMutex, pdMS_TO_TICKS(5)) == pdTRUE) {
      bool processedR18Epoch = R11Filter::processDualGnssFilterIfReady();
      if (processedR18Epoch) {
        // TI1R1 SINGLE-HISTORY: live GNSS remains the real-time authority.
        // Failed/outage samples are retained only by the existing offline queue;
        // do not create a second breadcrumb history stream in parallel.
        serviceGnssDiagnosticCaptureFromGpsTask();
        serviceRouteDecisionFromGpsTask();
      }
      if (r11A7670ParserMutex != nullptr) {
        xSemaphoreGive(r11A7670ParserMutex);
      }
    }

    // NEO diagnostics are emitted only after the UART has been drained and
    // R11 processing for this service pass has completed.
    GsvDiagnostics::serviceNeo();
    monitorLoop1AndHttpStall();

    vTaskDelay(pdMS_TO_TICKS(receivedNeoBytes ? 1 : 2));
  }
}

static void startGpsAcquisitionTask() {
  if (task_gps_acquisition != nullptr) {
    return;
  }

  GsvDiagnostics::begin();

  neoLimiterStream = xStreamBufferCreate(NEO_LIMITER_STREAM_BUFFER_SIZE, 1);
  r11A7670ParserMutex = xSemaphoreCreateMutex();

  if (neoLimiterStream == nullptr || r11A7670ParserMutex == nullptr) {
    Serial.println("[GNSS] Failed to allocate GPS acquisition resources; retaining Serial2 limiter fallback");
    if (neoLimiterStream != nullptr) {
      vStreamBufferDelete(neoLimiterStream);
      neoLimiterStream = nullptr;
    }
    if (r11A7670ParserMutex != nullptr) {
      vSemaphoreDelete(r11A7670ParserMutex);
      r11A7670ParserMutex = nullptr;
    }
    return;
  }

  BaseType_t result = xTaskCreatePinnedToCore(
    gpsAcquisitionTask,
    "gps_acquisition",
    12288,
    NULL,
    2,
    &task_gps_acquisition,
    !ARDUINO_RUNNING_CORE
  );

  if (result != pdPASS) {
    task_gps_acquisition = nullptr;
    vStreamBufferDelete(neoLimiterStream);
    neoLimiterStream = nullptr;
    vSemaphoreDelete(r11A7670ParserMutex);
    r11A7670ParserMutex = nullptr;
    Serial.println("[GNSS] Failed to start GPS acquisition task; retaining Serial2 limiter fallback");
    return;
  }

  Serial.println("[GNSS] Dedicated GPS acquisition task started; Serial2 owner=GPS task, limiter feed=raw NEO stream");
  Serial.println("[GNSS] R19.2 policy: protected R19 anchor/motion logic + stationary physical-source authority + moving dual-source fusion + reduced GNSS diagnostics + LBS total-loss fallback");
  Serial.println("[SIM] R19.2.1 policy: continuous failure-driven slot availability checks; no 20-minute failover blind gate; UNKNOWN is not MISSING");
  Serial.println("[GNSS] R17D2 A7670 diagnostics and network stall supervisor preserved");
}

// This custom version of delay() keeps the A7670 parser fed. NEO acquisition
// is independent and continuously serviced by gpsAcquisitionTask().
static void smartDelay(unsigned long ms) {
  unsigned long start = millis();
  do {
    feedA7670GpsParsersAvailable();
    yield();
    delay(1);
  } while (millis() - start < ms);
}

static void feedGpsParsers(unsigned long budgetMs = 5) {
  unsigned long start = millis();
  do {
    feedA7670GpsParsersAvailable();
    yield();
    delay(1);
  } while (millis() - start < budgetMs);
}

// Generate JWT Token
static void createJWT () {

  // IDENTITY SAFEGUARD - DO NOT REGRESS:
  // The server identifies this Xcela through the JWT number_plate claim.
  // Never create an apparently valid token with an empty/invalid vehicle ID.
  vehicleID.trim();
  if (!vehicleIdentityConfigured()) {
    number_plate = "";
    jwt_token = "";
    Serial.println("[AUTH] JWT NOT CREATED: Vehicle ID / Number Plate is not configured");
    return;
  }

  // Self-synchronize here as a second safety net so future direct createJWT()
  // calls cannot sign a stale number_plate value after vehicleID changes.
  number_plate = vehicleID;

  JsonDocument doc;

  JsonObject object = doc.to<JsonObject>();
  object["number_plate"] = number_plate;

  char str[80] = "";
  serializeJson(doc, str);

  #ifdef DEVELOPMENT
    CustomJWT jwt("secret", 256);
  #else
    CustomJWT jwt(jwt_secret, 256);
  #endif

  jwt.allocateJWTMemory();
  jwt.encodeJWT(str);
  jwt_token = (String)jwt.out;
  jwt.clear();

  Serial.print("JWT secret length: ");
  Serial.println(strlen(jwt_secret));
  Serial.print("JWT token length: ");
  Serial.println(jwt_token.length());
  Serial.print("[AUTH] JWT vehicle identity: ");
  Serial.println(number_plate);

  // TODO: Store token instead of secret, and do awaway with CustomJWT

}

bool vehicleIdentityConfigured() {
  String candidate = vehicleID;
  candidate.trim();
  return candidate.length() >= 7 && candidate.length() <= 32;
}

bool applyConfiguredVehicleIdentity(bool regenerateJwt, const char* reason) {
  vehicleID.trim();

  if (!vehicleIdentityConfigured()) {
    // Empty/too-short Vehicle ID must never silently fall back to ABC1234 for
    // authentication. ABC1234 is only a historical compile-time placeholder.
    number_plate = "";
    jwt_token = "";
    Serial.print("[AUTH] Vehicle ID / Number Plate NOT CONFIGURED");
    if (reason != nullptr && reason[0] != '\0') {
      Serial.print(" reason=");
      Serial.print(reason);
    }
    Serial.println();
    return false;
  }

  number_plate = vehicleID;
  Serial.print("[AUTH] Vehicle identity applied: ");
  Serial.print(number_plate);
  if (reason != nullptr && reason[0] != '\0') {
    Serial.print(" reason=");
    Serial.print(reason);
  }
  Serial.println();

  if (regenerateJwt) {
    if (strlen(jwt_secret) == 0) {
      jwt_token = "";
      Serial.println("[AUTH] JWT refresh deferred: jwt-secret.txt is not loaded");
    } else {
      createJWT();
    }
  }

  return true;
}

// Ticker Configurations
void sendTrackingDataHandler () {
  setScheduledRestartCriticalWork(true);
  if (number_plate != "null") {
    feedGpsParsers(50);
  } else {
    //Serial.println("Please configure number plate");
  }

  // Send Tracking Data
  sendTrackingData();
  setScheduledRestartCriticalWork(false);
}

bool scheduledRestartWouldInterfere();
void processPendingScheduledRestart();
void performScheduledRestart();
void markScheduledRestartPending();
void runSystemHealthMonitor();
void requestHealthRestart(const char* reason, bool critical);
void restoreRetainedGnssStateIfPresent();

enum ControlledRestartCause : uint8_t {
  RESTART_CAUSE_NONE = 0,
  RESTART_CAUSE_PREVENTIVE = 1,
  RESTART_CAUSE_HEALTH = 2
};

ControlledRestartCause pendingRestartCause = RESTART_CAUSE_NONE;
const char* pendingRestartDetail = "NONE";
bool pendingRestartCritical = false;
bool scheduledRestartPending = false;

void restartDeviceHandler () {
  // Never downgrade an already pending health restart to a routine 24-hour
  // preventive restart if both conditions happen to coincide.
  if (scheduledRestartPending && pendingRestartCause == RESTART_CAUSE_HEALTH) {
    return;
  }

  pendingRestartCause = RESTART_CAUSE_PREVENTIVE;
  pendingRestartDetail = "24H_PREVENTIVE";
  pendingRestartCritical = false;

  if (scheduledRestartWouldInterfere()) {
    Serial.println("[RESTART] Preventive restart deferred; important work is active or due soon");
    markScheduledRestartPending();
    return;
  }

  performScheduledRestart();
}

//Server
//ssid = "Vehicle ID 2"; //FLASH MEM
constexpr unsigned long PREVENTIVE_RESTART_INTERVAL_MS = 86400000UL; // 24 hours
TickTwo restartTimer(restartDeviceHandler, PREVENTIVE_RESTART_INTERVAL_MS, 1, MILLIS);
TaskHandle_t task_loop1;

const unsigned long realtimeSendInterval = 20000UL;
const unsigned long gpsBackgroundProcessIntervalMs = 10000UL;
const unsigned long invalidGpsTelemetryInterval = 300000UL;
const unsigned long commandPollInterval = 60000UL;
const unsigned long offlineReplayIntervalMoving = 60000UL;
// R19.2.4 TELEMETRY SAFEGUARD - DO NOT REGRESS:
// Stationary live telemetry is published every 6 minutes when unchanged.
// Do NOT reuse/change stationaryDuplicateWindow for this: that older 5-minute
// constant is also consumed by protected GNSS/offline logic.
const unsigned long stationaryTelemetrySendInterval = 360000UL;
const unsigned long stationaryDuplicateWindow = 300000UL;
const unsigned long realtimeGuardWindow = 8000UL;
const unsigned long gpsFixMaxAgeMs = 30000UL;
const unsigned long gpsHoldLastFixGraceMs = 120000UL;
const float stationaryLocationToleranceMeters = 30.0;
const int meaningfulFuelChangeThreshold = 10;
const int meaningfulBatteryChangeThreshold = 10;
const float meaningfulExtBatteryChangeThreshold = 0.20;
const int gpsMinTrackingSatellites = 5;
const float gpsMaxTrackingHdop = 4.5;
const int gpsMovingSpeedKmph = 6;
const float gpsMovingDistanceMeters = 15.0;
const float maxPlausibleJumpKmph = 180.0;
const unsigned long gprsSettleDelayMs = 3000UL;
const int minimumHttpSignalQuality = 11;
// R19.2.4 V4 INPUT SAFEGUARDS - DO NOT REGRESS.
// Debounce constants are declared earlier, before processPendingInterrupts(),
// for Arduino 1.8.19 compilation compatibility.

unsigned long lastRealtimeSendAt = 0;
unsigned long lastGpsBackgroundSampleAt = 0;
unsigned long lastCommandPollAt = 0;
unsigned long lastOfflineReplayAt = 0;
unsigned long lastSuccessfulTrackingSendAt = 0;
bool lastTrackingSendSkippedForStationary = false;
unsigned long scheduledRestartPendingSince = 0;
volatile bool scheduledRestartCriticalWorkActive = false;
const unsigned long scheduledRestartMaxDeferMs = 600000UL;
const unsigned long healthRestartMaxDeferMs = 30000UL;
const unsigned long healthCriticalRestartMaxDeferMs = 5000UL;
const unsigned long scheduledRestartGuardWindowMs = 15000UL;

// R14 health monitor. Thresholds are deliberately conservative initial
// guardrails; serial HEALTH lines provide field evidence for later tuning.
const unsigned long systemHealthCheckIntervalMs = 30000UL;
const unsigned long systemHealthLogIntervalMs = 300000UL;
const uint32_t healthCriticalFreeHeapBytes = 16384UL;
const uint32_t healthLowFreeHeapBytes = 32768UL;
const uint32_t healthLowLargestBlockBytes = 8192UL;
const UBaseType_t healthCriticalStackHeadroom = 256;
const UBaseType_t healthLowStackHeadroom = 512;
const uint8_t healthBadChecksBeforeRestart = 3;
unsigned long lastSystemHealthCheckAt = 0;
unsigned long lastSystemHealthLogAt = 0;
uint8_t consecutiveBadHealthChecks = 0;

extern bool hasLastOfflineRecord;
extern unsigned long lastOfflineStoredAt;

bool realtimeSendDue(unsigned long now) {
  return lastRealtimeSendAt == 0 || now - lastRealtimeSendAt >= realtimeSendInterval;
}

void runGpsBackgroundSampler() {
  unsigned long now = millis();
  if (lastGpsBackgroundSampleAt != 0 && now - lastGpsBackgroundSampleAt < gpsBackgroundProcessIntervalMs) {
    return;
  }

  if (scheduledRestartCriticalWorkActive) {
    return;
  }

  lastGpsBackgroundSampleAt = now;
  sampleGpsTrackingDataOnly();
}

unsigned long timeUntilRealtimeSend(unsigned long now) {
  if (realtimeSendDue(now)) {
    return 0;
  }

  return realtimeSendInterval - (now - lastRealtimeSendAt);
}

unsigned long currentOfflineReplayInterval(unsigned long now);

void setScheduledRestartCriticalWork(bool active) {
  scheduledRestartCriticalWorkActive = active;
}

static uint32_t r14HashBytes(uint32_t hash, const void* data, size_t len) {
  const uint8_t* bytes = static_cast<const uint8_t*>(data);
  for (size_t i = 0; i < len; ++i) {
    hash ^= bytes[i];
    hash *= 16777619UL;
  }
  return hash;
}

static uint32_t r14RetainedGnssChecksum(const R14RetainedGnssState& state) {
  uint32_t hash = 2166136261UL;
  hash = r14HashBytes(hash, &state.version, sizeof(state.version));
  hash = r14HashBytes(hash, &state.confirmedLat, sizeof(state.confirmedLat));
  hash = r14HashBytes(hash, &state.confirmedLon, sizeof(state.confirmedLon));
  hash = r14HashBytes(hash, &state.envelopeLat, sizeof(state.envelopeLat));
  hash = r14HashBytes(hash, &state.envelopeLon, sizeof(state.envelopeLon));
  hash = r14HashBytes(hash, &state.envelopeEstablished, sizeof(state.envelopeEstablished));
  hash = r14HashBytes(hash, &state.trusted, sizeof(state.trusted));
  return hash;
}

static void clearRetainedGnssState() {
  memset(&r14RetainedGnssState, 0, sizeof(r14RetainedGnssState));
}

static bool persistRetainedGnssStateForControlledRestart() {
  double confirmedLat = 0.0;
  double confirmedLon = 0.0;
  double envelopeLat = 0.0;
  double envelopeLon = 0.0;
  bool trusted = false;
  bool envelopeEstablished = false;

  if (!R11Filter::exportConfirmedStationaryReference(
          confirmedLat, confirmedLon, trusted, envelopeEstablished,
          envelopeLat, envelopeLon)) {
    clearRetainedGnssState();
    Serial.println("[RESTART] No protected stationary GNSS anchor to retain");
    return false;
  }

  R14RetainedGnssState next = {};
  next.version = R14_RETAINED_GNSS_VERSION;
  next.confirmedLat = confirmedLat;
  next.confirmedLon = confirmedLon;
  next.envelopeLat = envelopeLat;
  next.envelopeLon = envelopeLon;
  next.envelopeEstablished = envelopeEstablished ? 1 : 0;
  next.trusted = trusted ? 1 : 0;
  next.checksum = r14RetainedGnssChecksum(next);
  next.magic = R14_RETAINED_GNSS_MAGIC;
  r14RetainedGnssState = next;

  Serial.print("[RESTART] Retained stationary GNSS anchor class=");
  Serial.print(trusted ? "TRUSTED" : "PROTECTED_HOLDOVER");
  Serial.print(" lat=");
  Serial.print(confirmedLat, 7);
  Serial.print(" lon=");
  Serial.println(confirmedLon, 7);
  return true;
}

void restoreRetainedGnssStateIfPresent() {
  // R18.3: __NOINIT can survive software reset. Only consume a retained
  // anchor after the deliberate ESP.restart() reset class used by the
  // controlled health/preventive restart path. Other boot causes acquire fresh.
  esp_reset_reason_t resetReason = esp_reset_reason();
  if (resetReason != ESP_RST_SW) {
    clearRetainedGnssState();
    return;
  }

  if (r14RetainedGnssState.magic != R14_RETAINED_GNSS_MAGIC ||
      r14RetainedGnssState.version != R14_RETAINED_GNSS_VERSION) {
    return;
  }

  R14RetainedGnssState retained = r14RetainedGnssState;
  clearRetainedGnssState(); // consume once even if validation below fails

  if (retained.checksum != r14RetainedGnssChecksum(retained)) {
    Serial.println("[RESTART] Retained GNSS anchor checksum invalid; normal acquisition will run");
    return;
  }

  bool restored = R11Filter::restoreConfirmedStationaryReference(
      retained.confirmedLat, retained.confirmedLon, retained.trusted != 0,
      retained.envelopeEstablished != 0, retained.envelopeLat,
      retained.envelopeLon, millis());

  Serial.println(restored ?
      (retained.trusted ?
        "[RESTART] Controlled-restart TRUSTED stationary GNSS anchor restored" :
        "[RESTART] Controlled-restart PROTECTED_HOLDOVER stationary GNSS anchor restored") :
      "[RESTART] Retained GNSS anchor rejected; normal acquisition will run");
}

void performScheduledRestart() {
  Serial.print("[RESTART] Controlled restart cause=");
  Serial.print(pendingRestartCause == RESTART_CAUSE_HEALTH ? "HEALTH" : "PREVENTIVE");
  Serial.print(" detail=");
  Serial.println(pendingRestartDetail);
  Serial.println("[GPS] Persisting latest validated RT clock before controlled restart");
  currentReliableEpoch(true);
  persistRestartDiagnostic(
      pendingRestartCause == RESTART_CAUSE_HEALTH ? "HEALTH" : "PREVENTIVE",
      pendingRestartDetail);
  persistRetainedGnssStateForControlledRestart();
  delay(50);
  ESP.restart();
}

void markScheduledRestartPending() {
  if (scheduledRestartPending) {
    return;
  }

  scheduledRestartPending = true;
  scheduledRestartPendingSince = millis();
  Serial.print("[RESTART] Controlled restart pending cause=");
  Serial.print(pendingRestartCause == RESTART_CAUSE_HEALTH ? "HEALTH" : "PREVENTIVE");
  Serial.print(" detail=");
  Serial.print(pendingRestartDetail);
  Serial.print(" uptime_ms=");
  Serial.println(scheduledRestartPendingSince);
}

void requestHealthRestart(const char* reason, bool critical) {
  if (reason == nullptr) reason = "HEALTH_UNSPECIFIED";

  // Health degradation outranks a pending preventive restart.
  if (!scheduledRestartPending || pendingRestartCause != RESTART_CAUSE_HEALTH) {
    pendingRestartCause = RESTART_CAUSE_HEALTH;
    pendingRestartDetail = reason;
    pendingRestartCritical = critical;
    scheduledRestartPending = false;
    scheduledRestartPendingSince = 0;
    markScheduledRestartPending();
  } else if (critical && !pendingRestartCritical) {
    pendingRestartCritical = true;
    pendingRestartDetail = reason;
  }
}

bool scheduledRestartWouldInterfere() {
  unsigned long now = millis();

  unsigned long maxDeferMs = scheduledRestartMaxDeferMs;
  if (pendingRestartCause == RESTART_CAUSE_HEALTH) {
    maxDeferMs = pendingRestartCritical ?
        healthCriticalRestartMaxDeferMs : healthRestartMaxDeferMs;
  }

  if (scheduledRestartPendingSince != 0 && now - scheduledRestartPendingSince >= maxDeferMs) {
    Serial.println("[RESTART] Maximum controlled-restart defer window reached; restart will proceed");
    return false;
  }

  if (scheduledRestartCriticalWorkActive) {
    Serial.println("[RESTART] Deferring: critical work active");
    return true;
  }

  // Critical health degradation gets only the critical-work guard above.
  if (pendingRestartCause == RESTART_CAUSE_HEALTH && pendingRestartCritical) {
    return false;
  }

  if (timeUntilRealtimeSend(now) <= scheduledRestartGuardWindowMs) {
    Serial.println("[RESTART] Deferring: realtime send is due soon");
    return true;
  }

  if (lastCommandPollAt == 0 || now - lastCommandPollAt >= commandPollInterval) {
    Serial.println("[RESTART] Deferring: command poll is due");
    return true;
  }

  unsigned long offlineInterval = currentOfflineReplayInterval(now);
  if (lastOfflineReplayAt == 0 || now - lastOfflineReplayAt >= offlineInterval) {
    Serial.println("[RESTART] Deferring: offline replay is due");
    return true;
  }

  if (speedViolationState == VIOLATION_AWAITING_SENDING ||
      geofenceViolationState == VIOLATION_AWAITING_SENDING ||
      temperViolationState == VIOLATION_AWAITING_SENDING ||
      shouldSendAccidentAlert ||
      shouldSendPanicAlert) {
    Serial.println("[RESTART] Deferring: pending alert or violation");
    return true;
  }

  return false;
}

void processPendingScheduledRestart() {
  if (!scheduledRestartPending) {
    return;
  }

  if (scheduledRestartWouldInterfere()) {
    return;
  }

  scheduledRestartPending = false;
  scheduledRestartPendingSince = 0;
  performScheduledRestart();
}

static UBaseType_t taskStackHeadroom(TaskHandle_t handle) {
  if (handle == nullptr) return 0;
  return uxTaskGetStackHighWaterMark(handle);
}

void runSystemHealthMonitor() {
  unsigned long now = millis();
  if (lastSystemHealthCheckAt != 0 &&
      now - lastSystemHealthCheckAt < systemHealthCheckIntervalMs) {
    return;
  }
  lastSystemHealthCheckAt = now;

  uint32_t freeHeap = ESP.getFreeHeap();
  uint32_t minFreeHeap = ESP.getMinFreeHeap();
  uint32_t largestBlock = heap_caps_get_largest_free_block(MALLOC_CAP_8BIT);
  UBaseType_t loop1Headroom = taskStackHeadroom(task_loop1);
  UBaseType_t gpsHeadroom = taskStackHeadroom(task_gps_acquisition);

  bool criticalHeap = freeHeap < healthCriticalFreeHeapBytes;
  bool criticalStack =
      (loop1Headroom > 0 && loop1Headroom < healthCriticalStackHeadroom) ||
      (gpsHeadroom > 0 && gpsHeadroom < healthCriticalStackHeadroom);
  bool lowHeap = freeHeap < healthLowFreeHeapBytes;
  bool fragmented = largestBlock < healthLowLargestBlockBytes;
  bool lowStack =
      (loop1Headroom > 0 && loop1Headroom < healthLowStackHeadroom) ||
      (gpsHeadroom > 0 && gpsHeadroom < healthLowStackHeadroom);

  bool badHealth = lowHeap || fragmented || lowStack;
  if (badHealth) {
    if (consecutiveBadHealthChecks < 255) consecutiveBadHealthChecks++;
  } else {
    consecutiveBadHealthChecks = 0;
  }

  bool logDue = lastSystemHealthLogAt == 0 ||
      now - lastSystemHealthLogAt >= systemHealthLogIntervalMs || badHealth;
  if (logDue) {
    lastSystemHealthLogAt = now;
    Serial.print("HEALTH,FREE_HEAP,");
    Serial.print(freeHeap);
    Serial.print(",MIN_FREE_HEAP,");
    Serial.print(minFreeHeap);
    Serial.print(",LARGEST_BLOCK,");
    Serial.print(largestBlock);
    Serial.print(",LOOP1_STACK_HWM,");
    Serial.print((uint32_t)loop1Headroom);
    Serial.print(",GPS_STACK_HWM,");
    Serial.print((uint32_t)gpsHeadroom);
    Serial.print(",BAD_CHECKS,");
    Serial.print(consecutiveBadHealthChecks);
    Serial.print(",NEO_STREAM_DROPS,");
    Serial.println(neoLimiterStreamDroppedBytes);
  }

  if (criticalHeap) {
    requestHealthRestart("CRITICAL_FREE_HEAP", true);
    return;
  }
  if (criticalStack) {
    requestHealthRestart("CRITICAL_TASK_STACK", true);
    return;
  }
  if (consecutiveBadHealthChecks >= healthBadChecksBeforeRestart) {
    if (lowHeap) requestHealthRestart("SUSTAINED_LOW_FREE_HEAP", false);
    else if (fragmented) requestHealthRestart("SUSTAINED_HEAP_FRAGMENTATION", false);
    else requestHealthRestart("SUSTAINED_LOW_TASK_STACK", false);
  }
}

unsigned long currentOfflineReplayInterval(unsigned long now) {
  bool stationaryReplayWindowActive =
    hasLastOfflineRecord &&
    vehicle_state == "STATIONARY" &&
    now - lastOfflineStoredAt < stationaryDuplicateWindow;

  return stationaryReplayWindowActive ? realtimeSendInterval : offlineReplayIntervalMoving;
}

bool runNetworkScheduler() {
  unsigned long now = millis();
  serviceControlledModemRecovery();
  uint32_t routeTriggerMask = 0;

  if (!trackingOutage.active) {
    routeTriggerMask = consumeRouteLiveSendMask();
  } else {
    consumeRouteLiveSendMask();
  }

  if (routeTriggerMask != 0 || realtimeSendDue(now)) {
    sendTrackingDataHandler();
    lastRealtimeSendAt = millis();
    if (lastTrackingSendSkippedForStationary) {
      setScheduledRestartCriticalWork(true);
      uploadOfflineData();
      setScheduledRestartCriticalWork(false);
      lastOfflineReplayAt = millis();
    }
    return true;
  }

  if (timeUntilRealtimeSend(now) <= realtimeGuardWindow) {
    return false;
  }

  if (lastCommandPollAt == 0 || now - lastCommandPollAt >= commandPollInterval) {
    getCommandFromServer();
    lastCommandPollAt = millis();
    return true;
  }

  // TI1R1 LIVE PRIORITY: never replay historical data while the vehicle is
  // moving. Active movement uses only current live telemetry. The retained
  // offline queue drains once stationary, so history cannot compete with or
  // visually pull the live track backwards during a trip.
  if (vehicle_state == "STATIONARY") {
    unsigned long offlineInterval = currentOfflineReplayInterval(now);
    if (lastOfflineReplayAt == 0 || now - lastOfflineReplayAt >= offlineInterval) {
      setScheduledRestartCriticalWork(true);
      uploadOfflineData();
      setScheduledRestartCriticalWork(false);
      lastOfflineReplayAt = millis();
      return true;
    }
  }

  return false;
}

void esploop1(void* pvParameters) {
  setup1();
  for (;;)
    loop1();
}

// 1. First Core
void setup() {
  // R19.2.6: Disable brownout detector immediately on boot.
  // The A7670 modem's power-key current spike causes the ESP32 brownout
  // detector to fire an unplanned reset (reset_code=6) and the startup
  // buzzer to sound. The hardware power rail is adequate for normal operation;
  // the brownout threshold is simply too tight for the modem current profile.
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);

  // Initialize Serial Communication
  Serial.begin(9600);
  Serial.println();
  Serial.println("============================================================");
  Serial.println(XCELA_FIRMWARE_NAME);
  Serial.println("SETUP BEGIN");
  Serial.println("============================================================");
  Serial1.begin(115200, SERIAL_8N1, GSM_RX_PIN, GSM_TX_PIN);
  Serial2.begin(9600, SERIAL_8N1, RXD2, TXD2);

  SPI.begin(SCLK, -1, SDI, EPD_CS);
  SPI.setFrequency(4000000);
 
  display.init(115200);
  display.setRotation(1);
 
  // Draw the screen once (it will persist without power)
  display.setFullWindow();
  display.firstPage();
 
  // pin tasks to cores
  xTaskCreatePinnedToCore(
    esploop1,               /* Task function. */
    "loop1",                /* name of task. */
    10000,                  /* Stack size of task */
    NULL,                   /* parameter of the task */
    0,                      /* priority of the task */
    &task_loop1,            /* Task handle to keep track of created task */
    !ARDUINO_RUNNING_CORE
  ); /* pin task to core */

  analogReadResolution(12);
#if defined(XCELAV4)
  // R19.2.4 ADC SAFEGUARD - DO NOT REGRESS:
  // V4 conditioned analogue inputs are read with explicit attenuation so
  // analogReadMilliVolts() can provide calibrated processor-side millivolts.
  analogSetPinAttenuation(TEMPER_PROOF_PIN, ADC_11db);
  analogSetPinAttenuation(ADC_PIN, ADC_11db);
  analogSetPinAttenuation(ADC_PIN_2, ADC_11db);
  analogSetPinAttenuation(ADC_PIN_1, ADC_11db);
  analogSetPinAttenuation(FUEL_SENSOR_PIN, ADC_11db);
  analogSetPinAttenuation(PANIC_BUTTON_PIN, ADC_11db);
#endif

  // Initialize PINS
  /// relay 
  pinMode(RELAY_PIN, OUTPUT);

  /// buzzer
  pinMode(BUZZER_PIN, OUTPUT);

  digitalWrite(BUZZER_PIN, HIGH);
  delay(300);
  digitalWrite(BUZZER_PIN, LOW);

  /// gsm
  pinMode(GSM_PWR_KEY, OUTPUT);

  /// LDR / light-tamper input (GPIO2)
  // External analogue network defines the level. No internal pull-up and no
  // edge interrupt; processPendingInterrupts() polls and debounces it.
  pinMode(TEMPER_PROOF_PIN, INPUT);

  /// GPIO8 general input / accident profile
  // Hardware provides a pull-down, so a valid assertion is RISING/HIGH.
  pinMode(ACCIDENT_ALERT_PIN, INPUT);
  attachInterrupt(digitalPinToInterrupt(ACCIDENT_ALERT_PIN), onAccidentHandler, RISING);
  
  /// GPIO10 protected push/service/panic input
  // V4 production tests show LOW idle; trigger only on a RISING assertion.
  pinMode(PANIC_BUTTON_PIN, INPUT);
  attachInterrupt(digitalPinToInterrupt(PANIC_BUTTON_PIN), onPanicHandler, RISING);

  // Initialize SPIFFS
  delay(1000);

  if (!SPIFFS.begin()) {
    Serial.println("SPIFFS (SPIFFS) Mount Failed");
    return;
  } else {
    Serial.println("SPIFFS Successfully Mounted");
    recordAndDisplayBootRestartDiagnostic();
    // TI1R1: preserve any legacy TI1 /track-breadcrumbs.bin file untouched for
    // rollback/recovery, but do not activate it as a second runtime history queue.
    if (GNSS_DIAGNOSTIC_BOOT_DUMP_ENABLED) {
      dumpGnssDiagnosticLogsOnBoot();
    }
  }

  // Initialize Serial and GPS
  EEPROM.begin(EEPROM_SIZE); //Initialising EEPROM

  loadSerialFromEEPROM();
  loadConfigFromEEPROM();
  selectActiveAPN();

  if(speedLimit.toFloat()>0){
      
  SPEED_LIMIT =  speedLimit.toFloat();
  
    }

  //if(BOARD == '4'){
  // Keep vehicleID, number_plate and JWT identity as one authoritative value.
  // If EEPROM is blank, report it explicitly rather than authenticating with
  // an empty claim or a compile-time placeholder.
  applyConfiguredVehicleIdentity(false, "EEPROM load");
  
  //ssid = readEEpromWifi(0,15);//"Vehicle ID"; //FLASH MEM (0,15)

  // Assign ssid to number_plate
  
  //STRINGS
  //Serial.println("VEHICLE ID:");
  //ssid = readEEpromWifi(0, 15); //"Vehicle ID"; //FLASH MEM (0,15)

  // Get the JWT Secret from SPIFFS
  if (SPIFFS.exists("/jwt-secret.txt")) {
    File file = SPIFFS.open("/jwt-secret.txt", "r");
    String storedSecret = file.readString();
    storedSecret.trim();
    memset(jwt_secret, 0, sizeof(jwt_secret));
    storedSecret.toCharArray(jwt_secret, sizeof(jwt_secret));
    file.close();

    // Generate JWT only when a real configured Vehicle ID is available.
    createJWT();
    //Serial.println("JSON Web Token was successfully generated");
  } else {
    Serial.println("Upload jwt-secret.txt file into SPIFFS");
  }

  // Get the engine lock status
  if (SPIFFS.exists("/engine-lock-status.json")) {
    JsonDocument doc;

    File file = SPIFFS.open("/engine-lock-status.json", "r");
    deserializeJson(doc, file);
    file.close();

    JsonObject obj = doc.as<JsonObject>();
    isEngineLocked = obj["is_engine_locked"];

    if (isEngineLocked) {
      Serial.println("Engine locked");
    }
    else{
      Serial.println("Engine unlocked");
      }
    applyRelayState();

    Serial.println();
    Serial.print("Engine Lock Status obtained from SPIFFS i.e ");
    Serial.println(isEngineLocked);
  } else {
    Serial.println("Upload engine-lock-status.json file into SPIFFS");
  }

  // Initialize GSM module
  //initializeGSMModule();
  modem.restart();
  delay(2000);
  initializeGSMModule();
  delay(1000);

  //restoreFactoryDefaults();

  Serial1.println("AT +COPS=3,1"); // Instruct Modem to return a short format alphanumeric service provider name when requested
  delay(200);  
  Serial.println();  
  Serial.println("GSM says:" + Serial1.readString());

  // updating sketch
  //updateSketch();
  
  // Get Modem information
  modem_name = modem.getModemName();
  Serial.print("Modem Name:");
  Serial.println(modem_name);

  modem_info = modem.getModemInfo();
  
  if (modem_info == ""){
    modem_info = "DEFAULT";
    }
    
  Serial.print("Modem Info:");
  Serial.println(modem_info);

  // Initialize manual tracking by getting current active SIM
  updateActiveSIMTracking();
  discoverSIMSlotsAtBoot();

    // Check if current SIM has a card
  if (false && !isSIMCardPresent()) {
    Serial.println("⚠️ Current SIM slot has NO card!");
    
    if (currentActiveSIM == 1) {
      Serial.println("Attempting to switch to SIM 2...");
      switchSIM();  // Create this function
    } else if (currentActiveSIM == 2) {
      Serial.println("Attempting to switch to SIM 1...");
      switchSIM();
    }
    
    // Verify again after switch
    delay(2000);
    if (!isSIMCardPresent()) {
      Serial.println("❌ No SIM card in either slot!");
    }
  }
  
  Serial.println("\n=================================");
  Serial.print("MANUAL TRACKING: SIM ");
  Serial.print(currentActiveSIM);
  Serial.println(" is currently ACTIVE");
  Serial.println("=================================");
  //Enabling GPS
  Serial.println("Enabling GPS/GNSS/GLONASS");
  
  // R17D2 retains the R17D1 actual A7670 GNSS power-state verification instead of depending on
  // one specific +CGNSSPWR: READY! URC from the library enable helper.
  bool a7670GnssPowerOk = ensureA7670GnssPowerOn("BOOT");
  if (!a7670GnssPowerOk) {
    Serial.println("FAILED TO VERIFY A7670 GPS POWER AT BOOT");
  }

  configureA7670GpsOutput();
  if (A7670_FULL_BOOT_DIAGNOSTIC_ENABLED) {
    diagnoseA7670GnssState("BOOT_AFTER_CONFIG", true);
  } else {
    Serial.println("[A7670-GNSS] boot diagnostic snapshot skipped; acquisition continues immediately");
  }

  // Network timing is handled by runNetworkScheduler(); restart remains timer-based.
  restartTimer.start();
  //Serial1.print("AT+SWITCHSIM=1\r");
  //simCheck();  
  //checkSIM(1);
  //checkSIM(2);


  Serial.print("APN: ");
  Serial.println(apn);
  Serial.print("Number Plate: ");
  if (vehicleIdentityConfigured()) Serial.println(number_plate);
  else Serial.println("NOT CONFIGURED");
  //}
  //initGNSS_XTRA_SUPL();
  
  //else{
  digitalWrite(BUZZER_PIN, HIGH);
  delay(600);
  digitalWrite(BUZZER_PIN, LOW);
  //}
  
  loadGeofenceCache();
  runServer();
  
  Serial.println("SETUP 0 END");
  
  Serial.println("SETUP ENGINE CHECK: " + String(digitalRead(RELAY_PIN)));
  Serial.println("============================================================");
  Serial.println(XCELA_FIRMWARE_NAME);
  Serial.println("SETUP COMPLETE");
  Serial.println("============================================================");
  Run = true;
}


void setup1() {
Serial.println("SETUP 1");

while (Run == false) {
    delay(1000);
    Serial.println();
  };
  
  Serial.println("LOOP END");

  // R19.2 GNSS-only startup improvement: begin NEO acquisition immediately
  // after setup0 completes instead of waiting for setup1 diagnostic/file work.
  // Retained anchor state must be restored before the filter task starts.
  restoreRetainedGnssStateIfPresent();
  startGpsAcquisitionTask();

  File root = SPIFFS.open("/");
  if (!root || !root.isDirectory()) {
    Serial.println("ERROR: Failed to open root directory");
    return;
  }

File file = root.openNextFile();

while (file) {
Serial.printf("%-35s %8d bytes\n", file.name(), file.size());

    file = root.openNextFile();
  }

  recoverOfflineQueueRewriteArtifacts();
  
  Serial.println("----- START OF CONTENT -----");
  file = SPIFFS.open(fileName2);

  if (file) {
    while (file.available()) {
      Serial.write(file.read());  // Use write() to preserve formatting
    }
    file.close();
  } else {
    Serial.println("Could not open offline queue for printing");
  }
    
  Serial.println("\n------ END OF CONTENT ------\n");


  Serial.println("All files have been read.");
  applyStorageProfile();

  File originalFile = SPIFFS.open(fileName1);
  Serial.println("FILE1 OPENED");
  
  if (!originalFile) {
    Serial.println("Failed to open file");

    // Create a new data file
    File newFile = SPIFFS.open("/data.csv", "w");;


    if (!newFile) {
      Serial.println("Failed to create temporary file");
      //newFile.close();
    }

    newFile.close();
    originalFile = SPIFFS.open(fileName1);
  }

  size_t fileSize = originalFile.size(); // Get the file size

  if (fileSize < 3) {

    dataString = "Vehicle Reg: ," + ssid.substring(0, 7) + ",Speed Limit (k/h):," + String(SPEED_LIMIT) + ",Owner Number: ," + ownerNumber.substring(0, ownerNumber.length()) + "\n";
    writeDataToFile(fileName1, dataString);

    dataString = "Chassis :," + chassisNumber.substring(0, chassisNumber.length()) + ",Serial :," + serialNumber.substring(0, serialNumber.length()) + ", DOF:," + dateOfFitting.substring(0, dateOfFitting.length()) + "\n";
    writeDataToFile(fileName1, dataString);

    dataString = "Date,Time,Latitude,Longitude,Fuel, Speed \n";
    writeDataToFile(fileName1, dataString);

    Serial.println("File is empty");

  }

  else if (fileSize > maxSize1) {
    Serial.println("data.csv is above profile limit; trimming oldest rows safely");
    safeTrimCsvToLimits(fileName1, maxSize1, (int)rowsLimit1, 3);

  } else if(fileSize > 0.85*maxSize1){
    safeTrimCsvToLimits(fileName1, maxSize1, (int)rowsLimit1, 3);
    delay(2000);
  }
  
  originalFile.close();
  originalFile = SPIFFS.open(fileName2);
  Serial.println("FILE2 OPENED");

  if (!originalFile) {
    Serial.println("Offline queue missing or unreadable during setup");
    if (!SPIFFS.exists(fileName2)) {
      File newFile2 = SPIFFS.open(fileName2, "w");
      if (newFile2) {
        newFile2.close();
        refreshOfflineQueueFormatAfterRewrite(0);
        Serial.println("Created empty offline queue");
      } else {
        Serial.println("Failed to create offline queue");
      }
    } else {
      Serial.println("Offline queue exists but could not be opened; keeping it untouched");
    }
  } else {
    fileSize = originalFile.size(); // Get the file size
    originalFile.close();
    
    if (fileSize > maxSize2) {
      Serial.println("offlineData.csv is above profile limit; trimming oldest offline rows safely");
      safeTrimCsvToLimits(fileName2, maxSize2, (int)rowsLimit2, 0);

    } else if(fileSize > 0.85*maxSize2){
      Serial.println("offlineData.csv is near profile limit; trimming oldest offline rows safely");
      safeTrimCsvToLimits(fileName2, maxSize2, (int)rowsLimit2, 0);
    }
  }

  originalFile = SPIFFS.open(fileName3);
  Serial.println("FILE3 OPENED");
  if (!originalFile) {
    if (!SPIFFS.exists(fileName3)) {
      File newFile3 = SPIFFS.open(fileName3, "w");
      if (newFile3) newFile3.close();
    }
  } else {
    fileSize = originalFile.size(); // Get the file size
    originalFile.close();
    
    if (fileSize > maxSize3) {
      Serial.println("violations.csv is above profile limit; trimming oldest violation rows safely");
      safeTrimCsvToLimits(fileName3, maxSize3, (int)rowsLimit3, 0);

    } else if(fileSize > 0.85*maxSize3){
      safeTrimCsvToLimits(fileName3, maxSize3, (int)rowsLimit3, 0);
      delay(1000);
    }
  }

  delay(2000);
  
  setupWatchdog();
  Run1  = true;

  //updateOffline();
}

void loop() {
  
server.handleClient();
processPendingInterrupts();
  // Check for authentication timeout
if (isAuthenticated && millis() > authTimeout) {
    isAuthenticated = false;
    successMessage = "";
    Serial.println("Authentication expired");
  }
//Serial.println(">>  TEST"); 
//smartDelay(15000);
 //displayInfo();
 //Serial.println("MAIN LOOP"); 
 //Serial.println(Run1); 

//delay(2000);
//while (Serial1.available()) Serial.write(Serial1.read());

//  int state1 = digitalRead(ACCIDENT_ALERT_PIN );
//  int state2 = digitalRead(TEMPER_PROOF_PIN);
//  int state3 = digitalRead(PANIC_BUTTON_PIN);

// Print states
//  Serial.print("Pin A: ");
//  Serial.print(state1);
//  Serial.print(" | Pin B: ");
//  Serial.print(state2);
//  Serial.print(" | Pin C: ");
//  Serial.println(state3);
  
//delay(1000);
//kickWatchdog();
deviceConfig();
//getTrackingData();

//if(!isEngineLocked){
while (limiterNeoSerialAvailable() > 0) { 
    //Serial.println(F("TEST"));
    if (neoGPS.encode(limiterNeoSerialRead())) {

      if (neoGPS.location.isValid()) {
      //Serial.print(F("- latitude: "));
      //Serial.println(neoGPS.location.lat(),6);
      lati = String(neoGPS.location.lat(),6);

      //Serial.print(F("- longitude: "));
      //Serial.println(neoGPS.location.lng(),6);
      lngi = String(neoGPS.location.lng(),6);

      Ngps_hdop = neoGPS.hdop.hdop();
      Ngps_day = neoGPS.date.day();
      Ngps_month = neoGPS.date.month();
      Ngps_year = neoGPS.date.year();
      Ngps_hour = neoGPS.time.hour();
      Ngps_minute = neoGPS.time.minute();
      Ngps_second = neoGPS.time.second();
       
      //````````Serial.print(F("- satelites: "));
      sats = neoGPS.satellites.value(); 
      //Serial.println(sats);

      if (neoGpsSpeedIsReliable()) {
        speedKmph = neoGPS.speed.kmph();

        if (speedKmph < 0.94*SPEED_LIMIT ){
            flag1 = false;
            digitalWrite(BUZZER_PIN, LOW);
        }  
        else if ((speedKmph >= 0.94*SPEED_LIMIT && speedKmph <= SPEED_LIMIT && flag1 == false) || count != 0){
            setSpeedLimiterRelayRequest(true);

            if (count <= 2){
               digitalWrite(BUZZER_PIN, HIGH);
               count++;
            }
            else if (count > 2 && count < 5){
               digitalWrite(BUZZER_PIN, LOW);
               count++;
            }
            else{
               count = 0;  
            }
        }
        else if (speedKmph <= SPEED_LIMIT) {
            setSpeedLimiterRelayRequest(false);
            digitalWrite(BUZZER_PIN, LOW);
        } 
        else if (speedKmph > SPEED_LIMIT) {
            setSpeedLimiterRelayRequest(true);
            digitalWrite(BUZZER_PIN, HIGH);
            flag1 = true;
        }
      } else {
        count = 0;
        flag1 = false;
        digitalWrite(BUZZER_PIN, LOW);
      }
    }
  }
}

if (millis() > 600000 && neoGPS.charsProcessed() < 10){
  setGpsLossRelayRequest(false);
  digitalWrite(BUZZER_PIN, LOW);
  warning();
  setGpsLossRelayRequest(true);
  delay(10000);
}

if (sats == 0){
  sCount++;
  if (sCount == 1){
     zeroOne = millis();
  }
  else if (sCount == 2){
     zeroTwo = millis();
  }
  else{
     sCount = 0;
  }
  
}

if (millis() > 600000 && (zeroTwo - zeroOne < 1000) && (millis() - zeroTwo < 1000)){
    setGpsLossRelayRequest(false);
    digitalWrite(BUZZER_PIN, LOW);
    sCount2++;
    if (sCount2 > 120000){
      warning();
      delay(10000);
    }
}
//}

if (isEngineLocked){
  //Serial.println("ENGINE LOCKED: " + String(digitalRead(RELAY_PIN)));
  applyRelayState();
  delay(5000);
  }

else{
  applyRelayState();
  // Serial.println("ENGINE UNLOCKED: " + String(digitalRead(RELAY_PIN)));
  }
 if(Run1){doThisAtEvery(4800);};
 delay(2500);
}

void loop1() {

loop1HeartbeatMs = millis();
ePaper();
  if (Run1) {
//    while(!gps.location.isValid() && millis() < 180000){
//      Serial.println("---------------  WAITING FOR A7670E  -----------------");
//      displayInfo();
//      kickWatchdog();
//      delay(1000);
//    }
  kickWatchdog();
  processPendingInterrupts();
  feedGpsParsers(10);
  runGpsBackgroundSampler();
  //delay(500);
    //if (Run) {
  //displayInfo();
    checkFuel();
    feedGpsParsers(5);
    checkIgnition();
    feedGpsParsers(5);
    internalBattery(); 
    feedGpsParsers(5);
    externalBattery();   
    feedGpsParsers(5);
    // R19: persist GNSS diagnostics from the GPS-task RAM queue, then service
    // LBS only if both GNSS receivers have had no fresh coordinate for the
    // configured total-loss interval. Neither operation changes R11 filtering.
    serviceGnssDiagnosticStorage();
    if (timeUntilRealtimeSend(millis()) > realtimeGuardWindow) {
      serviceLbsFallback();
    }
    //displayInfo(); 
    loop1HeartbeatMs = millis();
    bool networkJobRan = runNetworkScheduler();
    loop1HeartbeatMs = millis();
    delay(200);
    if (!networkJobRan && timeUntilRealtimeSend(millis()) > realtimeGuardWindow) {
      setScheduledRestartCriticalWork(true);
      sendViolations();
      delay(200);
      sendAlerts();
      setScheduledRestartCriticalWork(false);
      delay(200);
    }
    runSystemHealthMonitor();
    processPendingScheduledRestart();
    restartTimer.update();
    delay(200);
    //uploadOfflineDataMulti();

  }
  else{
    //deviceConfig();
    }
}

void warning() {
  String lostSigTime;
  String foundSigTime;
  sCount2 = 0;
  for (int i = 0; i < 171; ++i)
  {
    //digitalWrite(BUZZER_PIN, HIGH);
    delay(1000);
    //digitalWrite(BUZZER_PIN, LOW);
    delay(1000);

    while (limiterNeoSerialAvailable() > 0) {
      if (neoGPS.encode(limiterNeoSerialRead())) {

        if (neoGPS.location.isValid()) {
          //Serial.print(F("- satelites: "));

          sats = neoGPS.satellites.value();
          //Serial.println(sats);
        }
      }
    }

    //if there are no satelites, then there is no signal
    if (sats == 0) {
      sCount++;
      if (sCount == 1) {
        zeroOne = millis(); //first signal unavailability
      }
      else if (sCount == 2) {
        zeroTwo = millis(); //second signal unavailability
      }
      else {
        sCount =  0;
        //return;
      }
    }

    else if (sats > 2) {
      //sCount = 0;
      return;
    }

    //consistent unavailability of   n                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           for less than 1 second for 300 times
    if ((zeroTwo - zeroOne < 1000) && (millis() - zeroTwo < 1000)) {
      sCount2++;
    }

  }

  //digitalWrite(BUZZER_PIN, HIGH);
  
  //Switch off pump after 1.5 minutes
  delay(30000);
  setGpsLossRelayRequest(true);

//  if (limpTrigger1 == 1) {
//    eepromWrite(173, String(1));
//  }

  delay(6000);
  //ESP.restart();

  //sCount2 = 0;
  //ESP.restart();
}


// Functions for the TRECURITY contingency board

void initializeGSMModule() { //Turns on the A7670 chip onboard
  digitalWrite(GSM_PWR_KEY, HIGH);
  delay(500);
  digitalWrite(GSM_PWR_KEY, LOW);
  delay(1000);
}

void displayInfo() { //Prints out data from the NEO GPS module
  Serial.println("Location: ");
  if (gps.location.isValid()) {
    Serial.print("Lat: ");
    Serial.print(String(gps.location.lat(),6)); //, 6
    Serial.print(F(","));
    Serial.print("Lng: ");
    Serial.print(gps.location.lng(), 6);
    Serial.print(F(","));
    Serial.print("Sat: ");
    Serial.print(gps.satellites.value());
    Serial.print(F(","));
    Serial.print("Time: ");
    Serial.print(gps.time.hour());
    Serial.print(": ");
    Serial.print(gps.time.minute());
    Serial.print(": ");
    Serial.print(gps.time.second());
    Serial.println();
  }
  else {
    Serial.print("A7670E  INVALID");
  }
 
  Serial.println();
 
  if (neoGPS.location.isValid()) {
    Serial.print("Lat: ");
    Serial.print(neoGPS.location.lat(), 6);
    Serial.print(F(","));
    Serial.print("Lng: ");
    Serial.print(neoGPS.location.lng(), 6);
    Serial.print(F(","));
    Serial.print("Sat: ");
    Serial.print(neoGPS.satellites.value());
    Serial.print(F(" , "));
    Serial.print("Time: ");
    Serial.print(neoGPS.time.hour());    
    Serial.print(": ");
    Serial.print(neoGPS.time.minute());
    Serial.print(": ");
    Serial.print(gps.time.second());
    Serial.println();
  }
  else {
    Serial.println(F("NEO-GPS INVALID"));
}
}

static float averagedAdcMillivolts(uint8_t pin, int numSamples = 100) {
  uint64_t totalMv = 0;
  for (int i = 0; i < numSamples; i++) {
    totalMv += analogReadMilliVolts(pin);
    delay(10);
  }
  return (float)totalMv / (float)numSamples;
}

void internalBattery(){
  // R19.2.4 ADC FIX - DO NOT REGRESS:
  // GPIO4 has a nominal 10k/1k divider. Processor-side voltage must be
  // reconstructed by ~x11, not x1.1. analogReadMilliVolts() also avoids the
  // old hard-coded 3.3 V ADC reference and arbitrary 1.157 correction factor.
  float adcMv = averagedAdcMillivolts(ADC_PIN);
  float batteryVoltage = (adcMv / 1000.0f) * RESISTOR_RATIO;

  Serial.print("Battery Voltage: ");
  Serial.print(batteryVoltage, 2);
  Serial.println("V");
  
  battery_percentage = round(((batteryVoltage-3.7)/0.495)*100) ;

  if (battery_percentage > 100) {
    battery_percentage = 100;
  }

  if (battery_percentage < 0){
    battery_percentage = 0;
  }

  delay(1000); 
}

void externalBattery(){
  // R19.2.4 ADC FIX - DO NOT REGRESS:
  // GPIO5 vehicle/VIN sense uses the same nominal 10k/1k divider. A 12 V
  // vehicle input should therefore reconstruct from roughly 1.09 V at GPIO5
  // to roughly 12 V at the external input, subject to board tolerance.
  float adcMv = averagedAdcMillivolts(ADC_PIN_2);
  float measuredVoltage = adcMv / 1000.0f;
  extBatteryVoltage = round((measuredVoltage * RESISTOR_RATIO) * 10.0f) / 10.0f;

  Serial.print("EXT Battery Voltage: ");
  Serial.print(extBatteryVoltage, 1);
  Serial.print("V (ADC ");
  Serial.print(adcMv, 0);
  Serial.println("mV)");
}

void checkIgnition(){
  // Preserve the existing 2.5 V vehicle-side threshold, but use calibrated
  // ADC millivolts and the same correct x11 divider reconstruction.
  float measuredVoltage = analogReadMilliVolts(ADC_PIN_1) / 1000.0f;
  float batteryVoltage = measuredVoltage * RESISTOR_RATIO;

  // Determine if the voltage is high or low
  if (batteryVoltage >= ADC_THRESHOLD) {
    Serial.println("HIGH");
    ignition = true;
  } else {
    Serial.println("LOW");
    ignition = false;
  }

  delay(1000); // Wait for a second before the next reading
}

void checkFuel(){
  const int numSamples = 100; // Number of samples for averaging
  float adcSum = 0;

  // Take multiple readings for averaging
  for (int i = 0; i < numSamples; i++) {
    adcSum += analogRead((FUEL_SENSOR_PIN));
    delay(10); // Short delay between readings
  }

  // Calculate average ADC value
  float adcAverage = adcSum / numSamples;

  // Convert ADC value to voltage
  float measuredVoltage = (adcAverage / ADC_RESOLUTION) * ADC_REF_VOLTAGE;

  // Calculate battery voltage using the voltage divider ratio
  float sensorVoltage = measuredVoltage * (R3 + R4)/R3;

  sensorVoltage = (sensorVoltage*1.166*100.0)/100.0;

  if (adcAverage > 175){
    adcAverage = 175;
  }

  if (adcAverage < 0){
    adcAverage = 0;
  }
    
  // Map sensor voltage to fuel height (assuming linear relationship)
  float fuelHeight = 20*adcAverage/32.1111;//(10.5/17.34)*adcAverage ;//(sensorVoltage / SENSOR_MAX_VOLTAGE) * TANK_HEIGHT;

  // Calculate the fuel volume
  float fuelVolume = round(fuelHeight * TANK_AREA);
  
  // Print the results
  Serial.print("Analog Reading: ");
  Serial.print(adcAverage);//sensorVoltage
  Serial.println(" V");

  Serial.print("Fuel Height: ");
  Serial.print(fuelHeight);
  Serial.println(" cm");
  
  Serial.print("Fuel Volume: ");
  Serial.print(fuelVolume);
  Serial.println(" m^3");

  Serial.print("Fuel Volume: ");
  Serial.print(fuelVolume);
  Serial.println(" L");
  
  fuel_level = fuelVolume*2.94;//adcAverage;//round(fuelVolume*500); //adcAverage;//
  delay(1000); // Wait for a second before the next reading
}

void setupWatchdog() {
  // Initialize watchdog timer
  esp_task_wdt_init(WATCHDOG_TIMEOUT, true); // true = panic on timeout
  esp_task_wdt_add(NULL); // Add current task to watchdog
}

void kickWatchdog() {
  esp_task_wdt_reset();
}
