#include "CAN_OBD.h"

String createDate(int day, int month, int year, int hour, int minute, int second);
bool isValidDateTime(int day, int month, int year);
String vehicleGeofenceViolationState(float lat, float lng);
uint32_t epochFromDateString(String dateString);
uint32_t utcEpochFromLocalDateTime(int day, int month, int year, int hour, int minute, int second, int offsetMinutes);
String dateStringFromEpoch(uint32_t epoch);
String localDateTimeStringFromUtc(int day, int month, int year, int hour, int minute, int second);
void setLocalTimezoneOffsetMinutes(int offsetMinutes, const char* sourceLabel);
bool gpsClockEpochIsAcceptable(uint32_t epoch, const char* sourceLabel);
void persistGpsClockEpoch(uint32_t epoch, bool forceWrite);
uint32_t currentReliableEpoch(bool forcePersist);
void initializeTrackingBreadcrumbStorage();
void commands();
int gpsMovementSpeedThresholdKmph(int satellites, float hdop);
float gpsMovementDistanceThresholdMeters(int satellites, float hdop);
bool gpsMotionIndicatesMoving(int speedKmph, float distanceMeters, int satellites, float hdop, bool hasPreviousLocation);
static void processTrackingData(bool allowCriticalWork, bool verbose, unsigned long parserBudgetMs);
String readModemSerialFor(unsigned long timeoutMs);
void clearModemSerial();
void serviceMovingBreadcrumbCaptureFromGpsTask();
bool hasPendingMovingBreadcrumbs();
uint8_t pendingMovingBreadcrumbCount();
void acknowledgePreparedBreadcrumbBatch();


enum GpsFixTrustState {
  GPS_FAILED,
  GPS_POOR_BUT_USABLE,
  GPS_STALE_ONE_SHOT,
  GPS_TRUSTED
};

GpsFixTrustState currentGpsTrustState = GPS_FAILED;
bool currentGpsFixIsHoldover = false;
const int poorGpsSatelliteEncodingBase = 100;
const uint8_t poorGpsRequiredConsecutiveReadings = 3;
const unsigned long poorGpsOfflineIntervalMs = 420000UL;
const unsigned long staleGpsOneShotMaxAgeMs = 900000UL;
// A7670 GNSS recovery is intentionally delayed: require enough consecutive bad readings over a 5-minute bad streak.
const uint8_t a7670RecoveryBadReadingThreshold = 10;
const unsigned long a7670RecoveryMinBadStreakMs = 300000UL;
const unsigned long a7670RecoveryCooldownMs = 300000UL;
const unsigned long a7670SerialProgressGraceMs = 90000UL;
const uint8_t gpsStartupMedianRequiredStableFixes = 3;
const uint8_t gpsMedianWindowSize = 5;
const uint8_t gpsJumpRecoveryConfirmations = 3;
const uint8_t stationaryExitMovingConfirmations = 5;
const unsigned long stationaryExitEvidenceMinMs = 90000UL;
const unsigned long stationaryExitFastEvidenceMinMs = 30000UL;
static String lastReportedStaleA7670Key = "";
static unsigned long lastA7670RecoveryAt = 0;
static unsigned long lastA7670SerialProgressAt = 0;
static uint32_t lastA7670CharsProcessed = 0;
static unsigned long a7670BadStreakStartedAt = 0;
static unsigned long a7670BadStreakLastAt = 0;
static uint16_t a7670ConsecutiveBadReadings = 0;

struct GpsLocationSample {
  float lat;
  float lon;
};

GpsLocationSample gpsMedianSamples[gpsMedianWindowSize];
uint8_t gpsMedianSampleCount = 0;
uint8_t gpsMedianSampleNext = 0;

struct StationaryGpsAnchor {
  bool valid;
  float lat;
  float lon;
  unsigned long windowStartedAt;
  unsigned long updatedAt;
  uint16_t samples;
  float maxAcceptedDistance;
  bool hasOutsideCluster;
  float outsideClusterLat;
  float outsideClusterLon;
  unsigned long outsideClusterStartedAt;
  uint8_t outsideClusterCount;
};

StationaryGpsAnchor stationaryGpsAnchor = {
  false, 0.0, 0.0, 0, 0, 0, 0.0,
  false, 0.0, 0.0, 0, 0
};

// ============================================================
// R18/TI1 ADAPTIVE MOVING BREADCRUMBS - PERSISTENT AUTHORITY
// ============================================================
// TI1 fixes the documented R18 retention defect: the old 64-point RAM queue
// deleted the oldest unacknowledged route point when full. Every captured
// breadcrumb is now written to SPIFFS first. RAM is no longer the authority.
// Records are marked ACKED in place only after HTTP 200. Replay selects the
// newest pending history while generateJson() always keeps a live/current row
// last when one is available, so backlog replay cannot pull the displayed
// vehicle position backwards.
constexpr uint8_t TRACK_BREADCRUMB_MAX_PER_POST = 10;
constexpr uint8_t TRACK_BREADCRUMB_HISTORY_WITH_LIVE_MAX = 9;
constexpr uint32_t TRACK_BREADCRUMB_SLOW_INTERVAL_MS = 5000UL;
constexpr uint32_t TRACK_BREADCRUMB_NORMAL_INTERVAL_MS = 5000UL;
constexpr uint32_t TRACK_BREADCRUMB_FAST_INTERVAL_MS = 3000UL;
constexpr float TRACK_BREADCRUMB_SLOW_DISTANCE_M = 12.0f;
constexpr float TRACK_BREADCRUMB_NORMAL_DISTANCE_M = 30.0f;
constexpr float TRACK_BREADCRUMB_FAST_DISTANCE_M = 45.0f;
constexpr float TRACK_BREADCRUMB_HEADING_CHANGE_DEG = 20.0f;
constexpr uint32_t TRACK_BREADCRUMB_HEADING_MIN_INTERVAL_MS = 1500UL;

constexpr const char* TRACK_BREADCRUMB_STORE_FILE = "/track-breadcrumbs.bin";
constexpr const char* TRACK_BREADCRUMB_STORE_TEMP_FILE = "/track-breadcrumbs.tmp";
constexpr uint32_t TRACK_BREADCRUMB_STORE_MAGIC = 0x58434252UL; // "XCBR"
constexpr uint16_t TRACK_BREADCRUMB_STORE_VERSION = 1;
constexpr uint8_t TRACK_BREADCRUMB_RECORD_PENDING = 1;
constexpr uint8_t TRACK_BREADCRUMB_RECORD_ACKED = 2;
// Configured persistent limit. FIFO eviction is permitted only at this limit.
constexpr size_t TRACK_BREADCRUMB_STORE_MAX_BYTES = 450000UL;
constexpr uint16_t TRACK_BREADCRUMB_COMPACT_ACK_THRESHOLD = 128;


static SemaphoreHandle_t trackingBreadcrumbFileMutex = nullptr;
static uint32_t trackingBreadcrumbPersistentPending = 0;
static uint16_t trackingBreadcrumbAckedSinceCompact = 0;
static bool trackingBreadcrumbStorageReady = false;
static TrackingBreadcrumb latestCapturedBreadcrumb;
static bool haveLatestCapturedBreadcrumb = false;

static uint8_t preparedBreadcrumbCount = 0;
static uint32_t preparedBreadcrumbLastSequence = 0;
static uint32_t preparedBreadcrumbSequences[TRACK_BREADCRUMB_MAX_PER_POST] = {0};

static float breadcrumbHeadingDelta(float a, float b) {
  if (!isfinite(a) || !isfinite(b) || a < 0.0f || b < 0.0f) return 0.0f;
  float d = fabs(a - b);
  while (d >= 360.0f) d -= 360.0f;
  return d > 180.0f ? 360.0f - d : d;
}

static uint32_t breadcrumbRecordChecksum(const PersistentBreadcrumbRecord& record) {
  const uint8_t* bytes = reinterpret_cast<const uint8_t*>(&record.sequence);
  const size_t length = offsetof(PersistentBreadcrumbRecord, checksum) -
                        offsetof(PersistentBreadcrumbRecord, sequence);
  uint32_t hash = 2166136261UL;
  for (size_t i = 0; i < length; ++i) {
    hash ^= bytes[i];
    hash *= 16777619UL;
  }
  return hash;
}

static PersistentBreadcrumbRecord breadcrumbRecordFromPoint(const TrackingBreadcrumb& point) {
  PersistentBreadcrumbRecord record = {};
  record.magic = TRACK_BREADCRUMB_STORE_MAGIC;
  record.version = TRACK_BREADCRUMB_STORE_VERSION;
  record.state = TRACK_BREADCRUMB_RECORD_PENDING;
  record.sequence = point.sequence;
  record.capturedAtMs = point.capturedAtMs;
  record.capturedEpoch = point.capturedEpoch;
  record.lat = point.lat;
  record.lon = point.lon;
  record.satellites = (int16_t)point.satellites;
  record.hdop = point.hdop;
  record.ageMs = point.ageMs;
  record.altitude = (int16_t)point.altitude;
  record.course = point.course;
  record.speed = (int16_t)point.speed;
  record.moving = point.moving ? 1 : 0;
  record.checksum = breadcrumbRecordChecksum(record);
  return record;
}

static TrackingBreadcrumb breadcrumbPointFromRecord(const PersistentBreadcrumbRecord& record) {
  TrackingBreadcrumb point;
  point.sequence = record.sequence;
  point.capturedAtMs = record.capturedAtMs;
  point.capturedEpoch = record.capturedEpoch;
  point.lat = record.lat;
  point.lon = record.lon;
  point.satellites = record.satellites;
  point.hdop = record.hdop;
  point.ageMs = record.ageMs;
  point.altitude = record.altitude;
  point.course = record.course;
  point.speed = record.speed;
  point.moving = record.moving != 0;
  return point;
}

static bool breadcrumbRecordValid(const PersistentBreadcrumbRecord& record) {
  return record.magic == TRACK_BREADCRUMB_STORE_MAGIC &&
         record.version == TRACK_BREADCRUMB_STORE_VERSION &&
         (record.state == TRACK_BREADCRUMB_RECORD_PENDING ||
          record.state == TRACK_BREADCRUMB_RECORD_ACKED) &&
         record.checksum == breadcrumbRecordChecksum(record) &&
         isfinite(record.lat) && isfinite(record.lon);
}

static bool readBreadcrumbRecord(File& file, uint32_t offset, PersistentBreadcrumbRecord& record) {
  if (!file.seek(offset, SeekSet)) return false;
  return file.read(reinterpret_cast<uint8_t*>(&record), sizeof(record)) == sizeof(record);
}

static bool compactBreadcrumbStoreLocked(bool makeRoomForOne) {
  File source = SPIFFS.open(TRACK_BREADCRUMB_STORE_FILE, "r");
  if (!source) return false;

  const size_t recordSize = sizeof(PersistentBreadcrumbRecord);
  const size_t fileSize = source.size();
  const size_t maxRecords = TRACK_BREADCRUMB_STORE_MAX_BYTES / recordSize;

  uint32_t pendingCount = 0;
  uint32_t invalidRecordCount = 0;
  for (uint32_t offset = 0; offset + recordSize <= fileSize; offset += recordSize) {
    PersistentBreadcrumbRecord record;
    if (readBreadcrumbRecord(source, offset, record) && breadcrumbRecordValid(record)) {
      if (record.state == TRACK_BREADCRUMB_RECORD_PENDING) pendingCount++;
    } else {
      invalidRecordCount++;
    }
  }

  uint32_t allowedPending = (uint32_t)maxRecords;
  if (makeRoomForOne && allowedPending > 0) allowedPending--;
  uint32_t evictPending = pendingCount > allowedPending ? pendingCount - allowedPending : 0;

  source.seek(0, SeekSet);
  SPIFFS.remove(TRACK_BREADCRUMB_STORE_TEMP_FILE);
  File temp = SPIFFS.open(TRACK_BREADCRUMB_STORE_TEMP_FILE, "w");
  if (!temp) {
    source.close();
    return false;
  }

  uint32_t evicted = 0;
  uint32_t keptPending = 0;
  TrackingBreadcrumb newestKept;
  bool haveNewestKept = false;

  for (uint32_t offset = 0; offset + recordSize <= fileSize; offset += recordSize) {
    PersistentBreadcrumbRecord record;
    if (!readBreadcrumbRecord(source, offset, record) || !breadcrumbRecordValid(record)) {
      continue;
    }
    if (record.state != TRACK_BREADCRUMB_RECORD_PENDING) continue;
    if (evicted < evictPending) {
      evicted++;
      continue;
    }
    if (temp.write(reinterpret_cast<const uint8_t*>(&record), sizeof(record)) != sizeof(record)) {
      temp.close();
      source.close();
      SPIFFS.remove(TRACK_BREADCRUMB_STORE_TEMP_FILE);
      return false;
    }
    keptPending++;
    newestKept = breadcrumbPointFromRecord(record);
    haveNewestKept = true;
  }

  temp.close();
  source.close();

  const char* backupFile = "/track-breadcrumbs.bak";
  SPIFFS.remove(backupFile);
  bool hadOriginal = SPIFFS.exists(TRACK_BREADCRUMB_STORE_FILE);
  if (hadOriginal && !SPIFFS.rename(TRACK_BREADCRUMB_STORE_FILE, backupFile)) {
    SPIFFS.remove(TRACK_BREADCRUMB_STORE_TEMP_FILE);
    return false;
  }
  if (!SPIFFS.rename(TRACK_BREADCRUMB_STORE_TEMP_FILE, TRACK_BREADCRUMB_STORE_FILE)) {
    if (hadOriginal) SPIFFS.rename(backupFile, TRACK_BREADCRUMB_STORE_FILE);
    return false;
  }
  if (hadOriginal) SPIFFS.remove(backupFile);

  trackingBreadcrumbPersistentPending = keptPending;
  trackingBreadcrumbAckedSinceCompact = 0;
  if (haveNewestKept) {
    latestCapturedBreadcrumb = newestKept;
    haveLatestCapturedBreadcrumb = true;
  }

  if (invalidRecordCount > 0) {
    Serial.print("EVENT,TRACK_BREADCRUMB_CORRUPT_RECORDS_DISCARDED,COUNT,");
    Serial.println(invalidRecordCount);
  }

  if (evicted > 0) {
    Serial.print("EVENT,TRACK_BREADCRUMB_PERSIST_LIMIT_FIFO_EVICTED,COUNT,");
    Serial.print(evicted);
    Serial.print(",MAX_BYTES,");
    Serial.println(TRACK_BREADCRUMB_STORE_MAX_BYTES);
  }

  return true;
}

void initializeTrackingBreadcrumbStorage() {
  if (trackingBreadcrumbStorageReady) return;
  if (trackingBreadcrumbFileMutex == nullptr) {
    trackingBreadcrumbFileMutex = xSemaphoreCreateMutex();
  }
  if (trackingBreadcrumbFileMutex == nullptr) {
    Serial.println("EVENT,TRACK_BREADCRUMB_STORE_INIT_FAILED,MUTEX");
    return;
  }
  if (xSemaphoreTake(trackingBreadcrumbFileMutex, pdMS_TO_TICKS(2000)) != pdTRUE) {
    Serial.println("EVENT,TRACK_BREADCRUMB_STORE_INIT_FAILED,MUTEX_TIMEOUT");
    return;
  }

  const char* backupFile = "/track-breadcrumbs.bak";
  if (!SPIFFS.exists(TRACK_BREADCRUMB_STORE_FILE) && SPIFFS.exists(backupFile)) {
    SPIFFS.rename(backupFile, TRACK_BREADCRUMB_STORE_FILE);
    Serial.println("EVENT,TRACK_BREADCRUMB_STORE_RECOVERED_BACKUP");
  }
  if (!SPIFFS.exists(TRACK_BREADCRUMB_STORE_FILE)) {
    File created = SPIFFS.open(TRACK_BREADCRUMB_STORE_FILE, "w");
    if (created) created.close();
  }
  if (SPIFFS.exists(backupFile) && SPIFFS.exists(TRACK_BREADCRUMB_STORE_FILE)) {
    SPIFFS.remove(backupFile);
  }
  if (SPIFFS.exists(TRACK_BREADCRUMB_STORE_TEMP_FILE)) {
    SPIFFS.remove(TRACK_BREADCRUMB_STORE_TEMP_FILE);
  }

  // Boot recovery compacts away acknowledged/corrupt/partial records and
  // reconstructs the pending count from persistent state.
  bool ok = compactBreadcrumbStoreLocked(false);
  trackingBreadcrumbStorageReady = ok;
  xSemaphoreGive(trackingBreadcrumbFileMutex);

  if (ok) {
    Serial.print("EVENT,TRACK_BREADCRUMB_STORE_READY,PENDING,");
    Serial.println(trackingBreadcrumbPersistentPending);
  } else {
    Serial.println("EVENT,TRACK_BREADCRUMB_STORE_INIT_FAILED,RECOVERY");
  }
}

static bool persistTrackingBreadcrumb(const TrackingBreadcrumb& point) {
  if (!trackingBreadcrumbStorageReady) initializeTrackingBreadcrumbStorage();
  if (!trackingBreadcrumbStorageReady || trackingBreadcrumbFileMutex == nullptr) return false;

  if (xSemaphoreTake(trackingBreadcrumbFileMutex, pdMS_TO_TICKS(2000)) != pdTRUE) {
    return false;
  }

  File file = SPIFFS.open(TRACK_BREADCRUMB_STORE_FILE, "r");
  size_t currentBytes = file ? file.size() : 0;
  if (file) file.close();

  const size_t recordSize = sizeof(PersistentBreadcrumbRecord);
  if (currentBytes + recordSize > TRACK_BREADCRUMB_STORE_MAX_BYTES) {
    // This is the ONLY normal path that may evict an unacknowledged breadcrumb:
    // the configured persistent file limit has genuinely been reached.
    if (!compactBreadcrumbStoreLocked(true)) {
      xSemaphoreGive(trackingBreadcrumbFileMutex);
      return false;
    }
  }

  PersistentBreadcrumbRecord record = breadcrumbRecordFromPoint(point);
  File append = SPIFFS.open(TRACK_BREADCRUMB_STORE_FILE, "a");
  bool wrote = append &&
      append.write(reinterpret_cast<const uint8_t*>(&record), sizeof(record)) == sizeof(record);
  if (append) append.close();

  if (wrote) {
    trackingBreadcrumbPersistentPending++;
    latestCapturedBreadcrumb = point;
    haveLatestCapturedBreadcrumb = true;
  }

  xSemaphoreGive(trackingBreadcrumbFileMutex);
  return wrote;
}

static bool newestTrackingBreadcrumb(TrackingBreadcrumb& out) {
  if (!haveLatestCapturedBreadcrumb) return false;
  out = latestCapturedBreadcrumb;
  return true;
}

static void queueTrackingBreadcrumb(const TrackingBreadcrumb& point) {
  if (!persistTrackingBreadcrumb(point)) {
    // Do not silently pretend the point is retained. This event is a storage
    // integrity fault and must be visible in field logs.
    Serial.print("EVENT,TRACK_BREADCRUMB_PERSIST_FAILED,SEQ,");
    Serial.println(point.sequence);
    return;
  }

  Serial.print("EVENT,TRACK_BREADCRUMB_PERSISTED,SEQ,");
  Serial.print(point.sequence);
  Serial.print(",PENDING,");
  Serial.print(trackingBreadcrumbPersistentPending);
  Serial.print(",STATE,");
  Serial.print(point.moving ? "MOVING" : "STATIONARY");
  Serial.print(",LAT,");
  Serial.print(point.lat, 7);
  Serial.print(",LON,");
  Serial.print(point.lon, 7);
  Serial.print(",SPEED_KMH,");
  Serial.println(point.speed);
}

bool hasPendingMovingBreadcrumbs() {
  return trackingBreadcrumbPersistentPending > 0;
}

uint8_t pendingMovingBreadcrumbCount() {
  return trackingBreadcrumbPersistentPending > 255UL
      ? 255
      : (uint8_t)trackingBreadcrumbPersistentPending;
}

static uint8_t snapshotMovingBreadcrumbs(
    TrackingBreadcrumb* output,
    uint8_t maxCount,
    uint8_t& totalPending) {
  preparedBreadcrumbCount = 0;
  preparedBreadcrumbLastSequence = 0;
  totalPending = trackingBreadcrumbPersistentPending > 255UL
      ? 255
      : (uint8_t)trackingBreadcrumbPersistentPending;

  if (maxCount == 0 || trackingBreadcrumbPersistentPending == 0) return 0;
  if (!trackingBreadcrumbStorageReady) initializeTrackingBreadcrumbStorage();
  if (!trackingBreadcrumbStorageReady || trackingBreadcrumbFileMutex == nullptr) return 0;
  if (xSemaphoreTake(trackingBreadcrumbFileMutex, pdMS_TO_TICKS(2000)) != pdTRUE) return 0;

  File file = SPIFFS.open(TRACK_BREADCRUMB_STORE_FILE, "r");
  if (!file) {
    xSemaphoreGive(trackingBreadcrumbFileMutex);
    return 0;
  }

  const uint32_t recordSize = sizeof(PersistentBreadcrumbRecord);
  const uint32_t fileSize = file.size();
  TrackingBreadcrumb reversePoints[TRACK_BREADCRUMB_MAX_PER_POST];
  uint8_t found = 0;

  uint32_t alignedSize = fileSize - (fileSize % recordSize);
  for (uint32_t endOffset = alignedSize;
       endOffset >= recordSize && found < maxCount;
       endOffset -= recordSize) {
    uint32_t offset = endOffset - recordSize;
    PersistentBreadcrumbRecord record;
    if (!readBreadcrumbRecord(file, offset, record) || !breadcrumbRecordValid(record)) continue;
    if (record.state != TRACK_BREADCRUMB_RECORD_PENDING) continue;
    reversePoints[found] = breadcrumbPointFromRecord(record);
    found++;
  }
  file.close();

  // The selected set is newest-first conceptually, but place those records in
  // chronological order inside data[] so one payload itself never walks back.
  for (uint8_t i = 0; i < found; ++i) {
    uint8_t sourceIndex = found - 1 - i;
    output[i] = reversePoints[sourceIndex];
    preparedBreadcrumbSequences[i] = output[i].sequence;
  }

  preparedBreadcrumbCount = found;
  preparedBreadcrumbLastSequence = found > 0 ? output[found - 1].sequence : 0;
  xSemaphoreGive(trackingBreadcrumbFileMutex);
  return found;
}

void acknowledgePreparedBreadcrumbBatch() {
  if (preparedBreadcrumbCount == 0 || trackingBreadcrumbFileMutex == nullptr) return;
  if (xSemaphoreTake(trackingBreadcrumbFileMutex, pdMS_TO_TICKS(3000)) != pdTRUE) return;

  File file = SPIFFS.open(TRACK_BREADCRUMB_STORE_FILE, "r+");
  uint8_t acknowledged = 0;
  if (file) {
    const uint32_t recordSize = sizeof(PersistentBreadcrumbRecord);
    const uint32_t fileSize = file.size();
    for (uint32_t offset = 0;
         offset + recordSize <= fileSize && acknowledged < preparedBreadcrumbCount;
         offset += recordSize) {
      PersistentBreadcrumbRecord record;
      if (!readBreadcrumbRecord(file, offset, record)) continue;
      if (!breadcrumbRecordValid(record) || record.state != TRACK_BREADCRUMB_RECORD_PENDING) continue;

      bool preparedSequence = false;
      for (uint8_t i = 0; i < preparedBreadcrumbCount; ++i) {
        if (record.sequence == preparedBreadcrumbSequences[i]) {
          preparedSequence = true;
          break;
        }
      }
      if (!preparedSequence) continue;

      uint8_t ackState = TRACK_BREADCRUMB_RECORD_ACKED;
      if (file.seek(offset + offsetof(PersistentBreadcrumbRecord, state), SeekSet) &&
          file.write(&ackState, 1) == 1) {
        acknowledged++;
        if (trackingBreadcrumbPersistentPending > 0) trackingBreadcrumbPersistentPending--;
        trackingBreadcrumbAckedSinceCompact++;
      }
    }
    file.close();
  }

  Serial.print("EVENT,TRACK_BREADCRUMB_BATCH_ACK,MARKED,");
  Serial.print(acknowledged);
  Serial.print(",NEWEST_SEQ,");
  Serial.print(preparedBreadcrumbLastSequence);
  Serial.print(",REMAINING,");
  Serial.println(trackingBreadcrumbPersistentPending);

  preparedBreadcrumbCount = 0;
  preparedBreadcrumbLastSequence = 0;

  File sizeCheck = SPIFFS.open(TRACK_BREADCRUMB_STORE_FILE, "r");
  size_t storeBytes = sizeCheck ? sizeCheck.size() : 0;
  if (sizeCheck) sizeCheck.close();
  if (trackingBreadcrumbAckedSinceCompact >= TRACK_BREADCRUMB_COMPACT_ACK_THRESHOLD ||
      storeBytes > TRACK_BREADCRUMB_STORE_MAX_BYTES) {
    compactBreadcrumbStoreLocked(false);
  }

  xSemaphoreGive(trackingBreadcrumbFileMutex);
}

void serviceMovingBreadcrumbCaptureFromGpsTask() {
  static uint32_t lastSeenSequence = 0;
  static bool previousMotionKnown = false;
  static bool previousMoving = false;

  const R11Filter::ProcessedGpsOutput& out = R11Filter::latestOutput();
  if (!out.valid || out.sequence == 0 || out.sequence == lastSeenSequence) return;
  lastSeenSequence = out.sequence;

  bool stateKnown = out.motionStateKnown;
  bool moving = stateKnown && out.moving;
  bool stoppedTransition = previousMotionKnown && previousMoving && stateKnown && !moving;
  bool movingTransition = stateKnown && moving && (!previousMotionKnown || !previousMoving);

  TrackingBreadcrumb newest;
  bool haveNewest = newestTrackingBreadcrumb(newest);
  bool shouldQueue = false;

  if (moving) {
    float speedKmh = isfinite(out.speedKmh) ? out.speedKmh : 0.0f;
    uint32_t intervalMs = TRACK_BREADCRUMB_NORMAL_INTERVAL_MS;
    float distanceThresholdM = TRACK_BREADCRUMB_NORMAL_DISTANCE_M;

    if (speedKmh <= 10.0f) {
      intervalMs = TRACK_BREADCRUMB_SLOW_INTERVAL_MS;
      distanceThresholdM = TRACK_BREADCRUMB_SLOW_DISTANCE_M;
    } else if (speedKmh > 60.0f) {
      intervalMs = TRACK_BREADCRUMB_FAST_INTERVAL_MS;
      distanceThresholdM = TRACK_BREADCRUMB_FAST_DISTANCE_M;
    }

    if (movingTransition || !haveNewest) {
      shouldQueue = true;
    } else {
      uint32_t elapsedMs = (uint32_t)(out.updatedAtMs - newest.capturedAtMs);
      float distanceM = (float)R11Filter::distanceMeters(
          newest.lat, newest.lon, out.lat, out.lon);
      float headingDelta = breadcrumbHeadingDelta(newest.course, out.courseDeg);

      shouldQueue =
          elapsedMs >= intervalMs ||
          distanceM >= distanceThresholdM ||
          (elapsedMs >= TRACK_BREADCRUMB_HEADING_MIN_INTERVAL_MS &&
           headingDelta >= TRACK_BREADCRUMB_HEADING_CHANGE_DEG);
    }
  } else if (stoppedTransition) {
    // R18.2: the 50-point post-motion provisional centre is INTERNAL ONLY.
    // Do not publish it as a stop endpoint. The first public stationary point
    // is the later 100-point protected working reference.
    shouldQueue = R11Filter::stationaryPublicLocationReady();
    if (!shouldQueue) {
      Serial.println("EVENT,TRACK_BREADCRUMB_STOP_ENDPOINT_DEFERRED_UNTIL_WORKING_REFERENCE");
    }
  }

  if (shouldQueue && isfinite(out.lat) && isfinite(out.lon)) {
    TrackingBreadcrumb point;
    point.sequence = out.sequence;
    point.capturedAtMs = out.updatedAtMs;
    point.capturedEpoch = currentReliableEpoch(false);
    point.lat = (float)out.lat;
    point.lon = (float)out.lon;
    point.satellites = reportedDualGnssSatelliteCount();
    point.hdop = isfinite(out.hdop) ? out.hdop : 0.0f;
    point.ageMs = out.sourceAgeMs;
    point.altitude = isfinite(out.altitudeM) ? (int)round(out.altitudeM) : 0;
    point.course = isfinite(out.courseDeg) ? out.courseDeg : -1.0f;
    point.speed = moving && isfinite(out.speedKmh) ? (int)round(out.speedKmh) : 0;
    point.moving = moving;
    queueTrackingBreadcrumb(point);
  }

  previousMotionKnown = stateKnown;
  previousMoving = moving;
}

void resetA7670GpsParserState() {
  gps = TinyGPSPlus();
  lastReportedStaleA7670Key = "";
}

int reportedDualGnssSatelliteCount() {
  // R19.2.4 SATELLITE REPORTING RULE - DO NOT REGRESS:
  // External/reporting satellite count is the SIMPLE SUM of current/fresh
  // physical NEO-6 and A7670 satellite counts. This is intentionally separate
  // from GNSS estimator source authority, quality gates, HDOP, motion logic and
  // limiter logic. Never replace this reporting rule with min(), max(), or the
  // currently selected estimator source unless the user explicitly changes it.
  R11Filter::ReceiverGpsDiagnostic neo;
  R11Filter::ReceiverGpsDiagnostic a7670;
  R11Filter::getReceiverDiagnostics(neo, a7670);

  const uint32_t reportFreshnessMs = 30000UL;
  int total = 0;

  // "Simply add them" means estimator authority/quality does not choose the
  // reported count. A receiver contributes its current satellite count while
  // its own source data is still fresh; stale/absent receiver data contributes 0.
  if (neo.point.sourceAgeMs <= reportFreshnessMs) {
    total += max((int)neo.point.satellites, 0);
  }
  if (a7670.point.sourceAgeMs <= reportFreshnessMs) {
    total += max((int)a7670.point.satellites, 0);
  }

  // Holdover/fallback protection: if neither fresh physical snapshot is
  // reportable, retain the already-selected tracker count rather than emit 0.
  return total > 0 ? total : max(gps_satellites, 0);
}

int encodePoorGpsSatelliteCount(int actualSatellites) {
  if (actualSatellites < 0) {
    actualSatellites = 0;
  }
  if (actualSatellites > 99) {
    actualSatellites = 99;
  }
  return poorGpsSatelliteEncodingBase + actualSatellites;
}

bool isPlausibleTrackingCoordinate(float lat, float lon) {
  if (lat == 0.0 && lon == 0.0) {
    return false;
  }

  return lat >= -90.0 && lat <= 90.0 &&
         lon >= -180.0 && lon <= 180.0;
}

bool hasTrustedGpsQuality() {
  return gps_satellites >= gpsMinTrackingSatellites &&
         gps_hdop > 0 &&
         gps_hdop <= gpsMaxTrackingHdop &&
         gps_age >= 0 &&
         gps_age <= gpsFixMaxAgeMs &&
         isPlausibleTrackingCoordinate(gps_lat, gps_lon);
}

float gpsEstimatedAccuracyRadiusMeters(int satellites, float hdop) {
  if (hdop <= 0.0 || satellites <= 0) {
    return 120.0;
  }

  float radius = hdop * 8.0;
  if (satellites >= 10 && hdop <= 1.5) {
    radius *= 0.75;
  } else if (satellites >= 8 && hdop <= 2.5) {
    radius *= 1.0;
  } else if (satellites >= 6 && hdop <= 3.5) {
    radius *= 1.35;
  } else {
    radius *= 1.8;
  }

  return constrain(radius, 8.0, 120.0);
}

float gpsCurrentAccuracyRadiusMeters() {
  return gpsEstimatedAccuracyRadiusMeters(gps_satellites, gps_hdop);
}

float maxFloatValue(float first, float second) {
  return first > second ? first : second;
}

float minFloatValue(float first, float second) {
  return first < second ? first : second;
}

float medianFloat(float values[], uint8_t count) {
  for (uint8_t i = 0; i < count; i++) {
    for (uint8_t j = i + 1; j < count; j++) {
      if (values[j] < values[i]) {
        float tmp = values[i];
        values[i] = values[j];
        values[j] = tmp;
      }
    }
  }

  if (count == 0) {
    return 0.0;
  }

  if ((count % 2) == 1) {
    return values[count / 2];
  }

  return (values[(count / 2) - 1] + values[count / 2]) / 2.0;
}

void addGpsMedianSample(float lat, float lon) {
  gpsMedianSamples[gpsMedianSampleNext].lat = lat;
  gpsMedianSamples[gpsMedianSampleNext].lon = lon;
  gpsMedianSampleNext = (gpsMedianSampleNext + 1) % gpsMedianWindowSize;
  if (gpsMedianSampleCount < gpsMedianWindowSize) {
    gpsMedianSampleCount++;
  }
}

float stationaryGpsAnchorGateMeters() {
  float qualityGate = gpsCurrentAccuracyRadiusMeters() * 2.2f;
  float gate = maxFloatValue(stationaryLocationToleranceMeters, qualityGate);
  return minFloatValue(90.0f, maxFloatValue(25.0f, gate));
}

bool currentFixLooksStationaryForAnchor() {
  if (!hasTrustedGpsQuality() || currentGpsFixIsHoldover) {
    return false;
  }

  int speedThreshold = gpsMovementSpeedThresholdKmph(gps_satellites, gps_hdop);
  return gps_speed <= max(2, speedThreshold);
}

void resetStationaryOutsideCluster() {
  stationaryGpsAnchor.hasOutsideCluster = false;
  stationaryGpsAnchor.outsideClusterLat = 0.0;
  stationaryGpsAnchor.outsideClusterLon = 0.0;
  stationaryGpsAnchor.outsideClusterStartedAt = 0;
  stationaryGpsAnchor.outsideClusterCount = 0;
}

void seedStationaryGpsAnchor(float lat, float lon) {
  unsigned long now = millis();
  stationaryGpsAnchor.valid = true;
  stationaryGpsAnchor.lat = lat;
  stationaryGpsAnchor.lon = lon;
  stationaryGpsAnchor.windowStartedAt = now;
  stationaryGpsAnchor.updatedAt = now;
  stationaryGpsAnchor.samples = 1;
  stationaryGpsAnchor.maxAcceptedDistance = 0.0;
  resetStationaryOutsideCluster();
  lastlat = lat;
  lastlon = lon;

  Serial.print("[GPS] Stationary anchor seeded lat=");
  Serial.print(lat, 6);
  Serial.print(" lon=");
  Serial.println(lon, 6);
}

void resetStationaryGpsAnchor(const char* reason) {
  if (stationaryGpsAnchor.valid) {
    Serial.print("[GPS] Stationary anchor reset: ");
    Serial.println(reason);
  }

  stationaryGpsAnchor.valid = false;
  stationaryGpsAnchor.lat = 0.0;
  stationaryGpsAnchor.lon = 0.0;
  stationaryGpsAnchor.windowStartedAt = 0;
  stationaryGpsAnchor.updatedAt = 0;
  stationaryGpsAnchor.samples = 0;
  stationaryGpsAnchor.maxAcceptedDistance = 0.0;
  resetStationaryOutsideCluster();
}

float distanceFromStationaryGpsAnchor() {
  if (!stationaryGpsAnchor.valid || !isPlausibleTrackingCoordinate(gps_lat, gps_lon)) {
    return 0.0;
  }

  return gps.distanceBetween(gps_lat, gps_lon, stationaryGpsAnchor.lat, stationaryGpsAnchor.lon);
}

bool stationaryOutsideClusterIsConfirmed(float gateMeters) {
  if (!stationaryGpsAnchor.hasOutsideCluster) {
    return false;
  }

  unsigned long elapsedMs = millis() - stationaryGpsAnchor.outsideClusterStartedAt;
  return stationaryGpsAnchor.outsideClusterCount >= stationaryExitMovingConfirmations &&
         elapsedMs >= stationaryExitEvidenceMinMs;
}

void clampSelectedFixToStationaryAnchor(const char* reason) {
  if (vehicle_state != "STATIONARY" ||
      !stationaryGpsAnchor.valid ||
      !isPlausibleTrackingCoordinate(stationaryGpsAnchor.lat, stationaryGpsAnchor.lon) ||
      !isPlausibleTrackingCoordinate(gps_lat, gps_lon)) {
    return;
  }

  float distanceMeters = gps.distanceBetween(gps_lat, gps_lon, stationaryGpsAnchor.lat, stationaryGpsAnchor.lon);
  Serial.print("[GPS] Stationary anchor used for ");
  Serial.print(reason);
  Serial.print("; rejected selected drift=");
  Serial.print(distanceMeters);
  Serial.println("m");
  gps_lat = stationaryGpsAnchor.lat;
  gps_lon = stationaryGpsAnchor.lon;
  gps_speed = 0;
}

void rememberStationaryOutsideCandidate(float gateMeters) {
  unsigned long now = millis();

  if (stationaryGpsAnchor.hasOutsideCluster) {
    float clusterDistanceMeters = gps.distanceBetween(
      gps_lat,
      gps_lon,
      stationaryGpsAnchor.outsideClusterLat,
      stationaryGpsAnchor.outsideClusterLon
    );

    if (clusterDistanceMeters <= gateMeters) {
      stationaryGpsAnchor.outsideClusterCount++;
      float count = (float)stationaryGpsAnchor.outsideClusterCount;
      stationaryGpsAnchor.outsideClusterLat =
        ((stationaryGpsAnchor.outsideClusterLat * (count - 1.0f)) + gps_lat) / count;
      stationaryGpsAnchor.outsideClusterLon =
        ((stationaryGpsAnchor.outsideClusterLon * (count - 1.0f)) + gps_lon) / count;
      return;
    }
  }

  stationaryGpsAnchor.hasOutsideCluster = true;
  stationaryGpsAnchor.outsideClusterLat = gps_lat;
  stationaryGpsAnchor.outsideClusterLon = gps_lon;
  stationaryGpsAnchor.outsideClusterStartedAt = now;
  stationaryGpsAnchor.outsideClusterCount = 1;
}

void applyStationaryGpsAnchorFilterIfUseful() {
  if (vehicle_state != "STATIONARY" || !hasTrustedGpsQuality() || currentGpsFixIsHoldover) {
    return;
  }

  if (!stationaryGpsAnchor.valid) {
    seedStationaryGpsAnchor(gps_lat, gps_lon);
    return;
  }

  unsigned long now = millis();
  float distanceMeters = distanceFromStationaryGpsAnchor();
  float gateMeters = stationaryGpsAnchorGateMeters();

  if (distanceMeters > gateMeters) {
    rememberStationaryOutsideCandidate(gateMeters);

    if (!stationaryOutsideClusterIsConfirmed(gateMeters) || gps_speed <= 0) {
      Serial.print("[GPS] Stationary anchor held; rejected drift distance=");
      Serial.print(distanceMeters);
      Serial.print("m gate=");
      Serial.print(gateMeters);
      Serial.print(" outside=");
      Serial.print(stationaryGpsAnchor.outsideClusterCount);
      Serial.print("/");
      Serial.print(stationaryExitMovingConfirmations);
      if (stationaryOutsideClusterIsConfirmed(gateMeters) && gps_speed <= 0) {
        Serial.print(" speed=0");
      }
      Serial.println();
      gps_lat = stationaryGpsAnchor.lat;
      gps_lon = stationaryGpsAnchor.lon;
      gps_speed = 0;
      return;
    }

    Serial.println("[GPS] Stationary outside cluster confirmed; allowing movement decision");
    return;
  }

  resetStationaryOutsideCluster();

  if (now - stationaryGpsAnchor.windowStartedAt >= stationaryDuplicateWindow) {
    Serial.print("[GPS] Stationary anchor 5-minute aggregate complete samples=");
    Serial.print(stationaryGpsAnchor.samples);
    Serial.print(" maxDrift=");
    Serial.print(stationaryGpsAnchor.maxAcceptedDistance);
    Serial.println("m");
    stationaryGpsAnchor.windowStartedAt = now;
    stationaryGpsAnchor.samples = 1;
    stationaryGpsAnchor.maxAcceptedDistance = 0.0;
  }

  if (stationaryGpsAnchor.samples < 60000) {
    float count = (float)stationaryGpsAnchor.samples;
    stationaryGpsAnchor.lat = ((stationaryGpsAnchor.lat * count) + gps_lat) / (count + 1.0f);
    stationaryGpsAnchor.lon = ((stationaryGpsAnchor.lon * count) + gps_lon) / (count + 1.0f);
    stationaryGpsAnchor.samples++;
  } else {
    stationaryGpsAnchor.lat = (stationaryGpsAnchor.lat * 0.995f) + (gps_lat * 0.005f);
    stationaryGpsAnchor.lon = (stationaryGpsAnchor.lon * 0.995f) + (gps_lon * 0.005f);
  }

  stationaryGpsAnchor.updatedAt = now;
  stationaryGpsAnchor.maxAcceptedDistance = maxFloatValue(
    stationaryGpsAnchor.maxAcceptedDistance,
    distanceMeters
  );

  gps_lat = stationaryGpsAnchor.lat;
  gps_lon = stationaryGpsAnchor.lon;
  gps_speed = 0;
  lastlat = stationaryGpsAnchor.lat;
  lastlon = stationaryGpsAnchor.lon;
}

bool calculateGpsMedianFromValues(float latValues[], float lonValues[], uint8_t count, float& medianLat, float& medianLon) {
  if (count == 0 || count > gpsMedianWindowSize) {
    return false;
  }

  medianLat = medianFloat(latValues, count);
  medianLon = medianFloat(lonValues, count);
  return isPlausibleTrackingCoordinate(medianLat, medianLon);
}

bool selectedStartupGpsFixIsStable() {
  static bool startupLocationLocked = false;
  static GpsLocationSample startupSamples[gpsMedianWindowSize];
  static uint8_t startupSampleCount = 0;
  static uint8_t startupSampleNext = 0;

  if (startupLocationLocked || currentGpsFixIsHoldover) {
    return true;
  }

  startupSamples[startupSampleNext].lat = gps_lat;
  startupSamples[startupSampleNext].lon = gps_lon;
  startupSampleNext = (startupSampleNext + 1) % gpsMedianWindowSize;
  if (startupSampleCount < gpsMedianWindowSize) {
    startupSampleCount++;
  }

  float medianLat = 0.0;
  float medianLon = 0.0;
  float startupLatValues[gpsMedianWindowSize];
  float startupLonValues[gpsMedianWindowSize];
  for (uint8_t i = 0; i < startupSampleCount; i++) {
    startupLatValues[i] = startupSamples[i].lat;
    startupLonValues[i] = startupSamples[i].lon;
  }

  if (!calculateGpsMedianFromValues(startupLatValues, startupLonValues, startupSampleCount, medianLat, medianLon)) {
    return false;
  }

  float stableRadiusMeters = maxFloatValue(20.0f, gpsCurrentAccuracyRadiusMeters() * 2.5f);
  uint8_t stableFixes = 0;
  for (uint8_t i = 0; i < startupSampleCount; i++) {
    float distanceToMedian = gps.distanceBetween(startupSamples[i].lat, startupSamples[i].lon, medianLat, medianLon);
    if (distanceToMedian <= stableRadiusMeters) {
      stableFixes++;
    }
  }

  if (stableFixes >= gpsStartupMedianRequiredStableFixes) {
    gps_lat = medianLat;
    gps_lon = medianLon;
    startupLocationLocked = true;
    addGpsMedianSample(gps_lat, gps_lon);
    Serial.print("[GPS] Startup median lock established fixes=");
    Serial.print(stableFixes);
    Serial.print(" radius=");
    Serial.print(stableRadiusMeters);
    Serial.print(" lat=");
    Serial.print(gps_lat, 6);
    Serial.print(" lon=");
    Serial.println(gps_lon, 6);
    return true;
  }

  Serial.print("[GPS] Startup filter waiting for median-stable fixes ");
  Serial.print(stableFixes);
  Serial.print("/");
  Serial.print(gpsStartupMedianRequiredStableFixes);
  Serial.print(" samples=");
  Serial.print(startupSampleCount);
  Serial.print(" radius=");
  Serial.println(stableRadiusMeters);
  return false;
}

void applyGpsMedianFilterIfUseful() {
  if (!hasTrustedGpsQuality() || currentGpsFixIsHoldover) {
    return;
  }

  addGpsMedianSample(gps_lat, gps_lon);
  if (gpsMedianSampleCount < 3) {
    applyStationaryGpsAnchorFilterIfUseful();
    return;
  }

  int speedThreshold = gpsMovementSpeedThresholdKmph(gps_satellites, gps_hdop);
  if (gps_speed > speedThreshold + 2) {
    return;
  }

  float medianLat = 0.0;
  float medianLon = 0.0;
  float latValues[gpsMedianWindowSize];
  float lonValues[gpsMedianWindowSize];
  for (uint8_t i = 0; i < gpsMedianSampleCount; i++) {
    latValues[i] = gpsMedianSamples[i].lat;
    lonValues[i] = gpsMedianSamples[i].lon;
  }

  if (!calculateGpsMedianFromValues(latValues, lonValues, gpsMedianSampleCount, medianLat, medianLon)) {
    return;
  }

  float shiftMeters = gps.distanceBetween(gps_lat, gps_lon, medianLat, medianLon);
  float maxMedianShiftMeters = maxFloatValue(8.0f, gpsCurrentAccuracyRadiusMeters() * 2.0f);
  if (shiftMeters > maxMedianShiftMeters) {
    Serial.print("[GPS] Median filter ignored; shift=");
    Serial.print(shiftMeters);
    Serial.print("m max=");
    Serial.println(maxMedianShiftMeters);
    applyStationaryGpsAnchorFilterIfUseful();
    return;
  }

  if (shiftMeters >= 1.0) {
    Serial.print("[GPS] Median filtered stationary/slow fix shift=");
    Serial.print(shiftMeters);
    Serial.println("m");
  }

  gps_lat = medianLat;
  gps_lon = medianLon;
  applyStationaryGpsAnchorFilterIfUseful();
}

bool currentGpsFixIsPoorButUsable() {
  return currentGpsTrustState == GPS_POOR_BUT_USABLE;
}

bool currentGpsFixIsOneShotStaleLocation() {
  return currentGpsTrustState == GPS_STALE_ONE_SHOT;
}

bool hasSendableGpsQuality() {
  return hasTrustedGpsQuality() || currentGpsFixIsPoorButUsable() || currentGpsFixIsOneShotStaleLocation();
}

bool isCurrentGpsJumpOutlier() {
  static bool hasLastAcceptedFix = false;
  static float lastAcceptedLat = 0.0;
  static float lastAcceptedLon = 0.0;
  static unsigned long lastAcceptedAt = 0;
  static bool hasPendingJumpCluster = false;
  static float pendingJumpLat = 0.0;
  static float pendingJumpLon = 0.0;
  static uint8_t pendingJumpCount = 0;

  if (!hasTrustedGpsQuality()) {
    return true;
  }

  if (!hasLastAcceptedFix) {
    lastAcceptedLat = gps_lat;
    lastAcceptedLon = gps_lon;
    lastAcceptedAt = millis();
    hasLastAcceptedFix = true;
    hasPendingJumpCluster = false;
    pendingJumpCount = 0;
    return false;
  }

  float distanceMeters = gps.distanceBetween(gps_lat, gps_lon, lastAcceptedLat, lastAcceptedLon);
  unsigned long elapsedMs = millis() - lastAcceptedAt;
  if (elapsedMs < 1000UL) {
    elapsedMs = 1000UL;
  }

  float jumpKmph = (distanceMeters / 1000.0) / (elapsedMs / 3600000.0);
  float accuracyRadiusMeters = gpsCurrentAccuracyRadiusMeters();
  float dynamicToleranceMeters = maxFloatValue(stationaryLocationToleranceMeters, accuracyRadiusMeters * 3.0f);
  int speedThreshold = gpsMovementSpeedThresholdKmph(gps_satellites, gps_hdop);
  bool speedClaimsStationary = gps_speed <= max(2, speedThreshold - 2);
  bool impossibleBySpeed = distanceMeters > dynamicToleranceMeters &&
                           jumpKmph > maxPlausibleJumpKmph;
  bool stationaryTeleport = speedClaimsStationary &&
                            distanceMeters > maxFloatValue(120.0f, dynamicToleranceMeters * 4.0f) &&
                            elapsedMs <= 120000UL;
  bool impossibleJump = impossibleBySpeed || stationaryTeleport;

  if (impossibleJump) {
    float clusterRadiusMeters = maxFloatValue(25.0f, accuracyRadiusMeters * 2.0f);
    if (hasPendingJumpCluster) {
      float pendingDistanceMeters = gps.distanceBetween(gps_lat, gps_lon, pendingJumpLat, pendingJumpLon);
      if (pendingDistanceMeters <= clusterRadiusMeters) {
        pendingJumpCount++;
        pendingJumpLat = (pendingJumpLat + gps_lat) / 2.0;
        pendingJumpLon = (pendingJumpLon + gps_lon) / 2.0;
      } else {
        pendingJumpCount = 1;
        pendingJumpLat = gps_lat;
        pendingJumpLon = gps_lon;
      }
    } else {
      hasPendingJumpCluster = true;
      pendingJumpCount = 1;
      pendingJumpLat = gps_lat;
      pendingJumpLon = gps_lon;
    }

    if (pendingJumpCount >= gpsJumpRecoveryConfirmations) {
      Serial.print("[GPS] Jump cluster confirmed; accepting new position after ");
      Serial.print(pendingJumpCount);
      Serial.println(" stable rejected candidates");
      lastAcceptedLat = gps_lat;
      lastAcceptedLon = gps_lon;
      lastAcceptedAt = millis();
      hasPendingJumpCluster = false;
      pendingJumpCount = 0;
      return false;
    }

    Serial.print("[GPS] Rejected GPS outlier. Distance: ");
    Serial.print(distanceMeters);
    Serial.print("m, implied speed: ");
    Serial.print(jumpKmph);
    Serial.print("km/h, pending cluster ");
    Serial.print(pendingJumpCount);
    Serial.print("/");
    Serial.print(gpsJumpRecoveryConfirmations);
    Serial.print(", tolerance=");
    Serial.print(dynamicToleranceMeters);
    Serial.println("m");
    return true;
  }

  lastAcceptedLat = gps_lat;
  lastAcceptedLon = gps_lon;
  lastAcceptedAt = millis();
  hasPendingJumpCluster = false;
  pendingJumpCount = 0;
  return false;
}

bool hasTrustedGpsFix() {
  return hasTrustedGpsQuality() && !isCurrentGpsJumpOutlier();
}

float gpsMovementAccuracyMultiplier(int satellites, float hdop) {
  if (satellites >= 10 && hdop > 0.0 && hdop <= 1.5) {
    return 0.9;
  }
  if (satellites >= 8 && hdop > 0.0 && hdop <= 2.5) {
    return 1.0;
  }
  if (satellites >= 6 && hdop > 0.0 && hdop <= 3.5) {
    return 1.5;
  }
  if (satellites >= gpsMinTrackingSatellites && hdop > 0.0 && hdop <= gpsMaxTrackingHdop) {
    return 2.0;
  }
  return 3.0;
}

float gpsMovementDistanceThresholdMeters(int satellites, float hdop) {
  return gpsMovingDistanceMeters * gpsMovementAccuracyMultiplier(satellites, hdop);
}

int gpsMovementSpeedThresholdKmph(int satellites, float hdop) {
  float multiplier = gpsMovementAccuracyMultiplier(satellites, hdop);
  if (multiplier <= 1.0) {
    return gpsMovingSpeedKmph;
  }
  if (multiplier <= 1.5) {
    return gpsMovingSpeedKmph + 1;
  }
  return gpsMovingSpeedKmph + 2;
}

bool gpsMotionIndicatesMoving(int speedKmph, float distanceMeters, int satellites, float hdop, bool hasPreviousLocation) {
  int speedThreshold = gpsMovementSpeedThresholdKmph(satellites, hdop);
  float distanceThreshold = gpsMovementDistanceThresholdMeters(satellites, hdop);

  bool speedSaysMoving = speedKmph >= speedThreshold;
  bool distanceSaysMoving = hasPreviousLocation &&
                            speedKmph > 0 &&
                            distanceMeters > distanceThreshold;

  return speedSaysMoving || distanceSaysMoving;
}

String gpsSourceTimestamp(TinyGPSPlus& source);

float normalizedGpsHdop(TinyGPSPlus& source) {
  if (!source.hdop.isValid()) {
    return 0.0;
  }

  float hdop = source.hdop.hdop();
  if (hdop <= 0) {
    return 0.0;
  }

  if (hdop < 1.0) {
    return 1.0;
  }

  return hdop;
}

float normalizedCombinedHdop(TinyGPSPlus& first, TinyGPSPlus& second) {
  if (!first.hdop.isValid() || !second.hdop.isValid()) {
    return 0.0;
  }

  float combinedHdop = (first.hdop.hdop() + second.hdop.hdop()) / 2.0;
  if (combinedHdop <= 0) {
    return 0.0;
  }

  if (combinedHdop < 1.0) {
    return 1.0;
  }

  return combinedHdop;
}

float sanitizedGpsCourseValue(double courseDegrees) {
  if (!(courseDegrees >= 0.0 && courseDegrees <= 360.0)) {
    return -1;
  }

  long roundedCourse = (long)round(courseDegrees);
  if (roundedCourse >= 360) {
    return 0;
  }

  return (float)roundedCourse;
}

float sanitizedGpsCourse(TinyGPSPlus& source) {
  return source.course.isValid() ? sanitizedGpsCourseValue(source.course.deg()) : -1;
}

float weightedGpsCourseDegrees(float firstCourse, float firstWeight, float secondCourse, float secondWeight) {
  if (firstCourse < 0) {
    return secondCourse;
  }
  if (secondCourse < 0) {
    return firstCourse;
  }

  const double radiansPerDegree = PI / 180.0;
  double x = (cos(firstCourse * radiansPerDegree) * firstWeight) +
             (cos(secondCourse * radiansPerDegree) * secondWeight);
  double y = (sin(firstCourse * radiansPerDegree) * firstWeight) +
             (sin(secondCourse * radiansPerDegree) * secondWeight);

  if (x == 0.0 && y == 0.0) {
    return -1;
  }

  double fusedCourse = atan2(y, x) / radiansPerDegree;
  if (fusedCourse < 0.0) {
    fusedCourse += 360.0;
  }

  return sanitizedGpsCourseValue(fusedCourse);
}

int gpsSourceReliabilityScore(TinyGPSPlus& source) {
  if (!source.location.isValid() ||
      !source.satellites.isValid() ||
      !source.hdop.isValid() ||
      source.location.age() > gpsFixMaxAgeMs ||
      !isPlausibleTrackingCoordinate(source.location.lat(), source.location.lng())) {
    return 0;
  }

  float hdop = source.hdop.hdop();
  if (hdop <= 0 || hdop > gpsMaxTrackingHdop) {
    return 0;
  }

  int satellites = source.satellites.value();
  if (satellites < 0) {
    satellites = 0;
  }

  int score = min(satellites, 12) * 4;

  if (hdop <= 1.5) {
    score += 32;
  } else if (hdop <= 2.5) {
    score += 26;
  } else if (hdop <= 3.5) {
    score += 18;
  } else if (hdop <= gpsMaxTrackingHdop) {
    score += 10;
  }

  unsigned long age = source.location.age();
  if (age <= 1000UL) {
    score += 20;
  } else if (age <= 3000UL) {
    score += 16;
  } else if (age <= 5000UL) {
    score += 12;
  } else if (age <= 10000UL) {
    score += 8;
  } else {
    score += 4;
  }

  return constrain(score, 0, 100);
}

int gpsReliabilityTier(int score) {
  if (score >= 75) {
    return 3;
  }
  if (score >= 50) {
    return 2;
  }
  if (score >= 25) {
    return 1;
  }
  return 0;
}

bool gpsReliabilityScoresAreCompatibleForFusion(int firstScore, int secondScore) {
  const int maxGpsReliabilityScoreGapForFusion = 30;

  if (firstScore <= 0 || secondScore <= 0) {
    return false;
  }

  int scoreGap = abs(firstScore - secondScore);
  if (scoreGap > maxGpsReliabilityScoreGapForFusion) {
    return false;
  }

  return gpsReliabilityTier(firstScore) == gpsReliabilityTier(secondScore) ||
         (firstScore >= 65 && secondScore >= 65);
}

void selectGpsSource(TinyGPSPlus& source) {
  gps_satellites = source.satellites.isValid() ? source.satellites.value() : 0;
  gps_hdop = normalizedGpsHdop(source);
  gps_lat = source.location.isValid() ? source.location.lat() : 0;
  gps_lon = source.location.isValid() ? source.location.lng() : 0;
  gps_age = source.location.isValid() ? source.location.age() : 0;
  gps_day = source.date.isValid() ? source.date.day() : 0;
  gps_month = source.date.isValid() ? source.date.month() : 0;
  gps_year = source.date.isValid() ? source.date.year() : 0;
  gps_hour = source.time.isValid() ? source.time.hour() : 0;
  gps_minute = source.time.isValid() ? source.time.minute() : 0;
  gps_second = source.time.isValid() ? source.time.second() : 0;
  gps_altitude = source.altitude.isValid() ? round(source.altitude.meters()) : 0;
  gps_course = sanitizedGpsCourse(source);
  gps_speed = source.speed.isValid() ? round(source.speed.kmph()) : 0;
}

bool neoGpsSpeedIsReliable() {
  return neoGPS.location.isValid() &&
         neoGPS.location.age() <= gpsFixMaxAgeMs &&
         neoGPS.speed.isValid() &&
         neoGPS.satellites.isValid() &&
         neoGPS.satellites.value() >= 4 &&
         neoGPS.hdop.isValid() &&
         normalizedGpsHdop(neoGPS) > 0 &&
         normalizedGpsHdop(neoGPS) <= gpsMaxTrackingHdop;
}

bool a7670HasStrongFix() {
  return gps.location.isValid() &&
         gps.satellites.isValid() &&
         gps.hdop.isValid() &&
         gps.satellites.value() >= 4 &&
         gps.hdop.hdop() > 0 &&
         gps.hdop.hdop() <= gpsMaxTrackingHdop &&
         gps.location.age() <= 10000UL &&
         isPlausibleTrackingCoordinate(gps.location.lat(), gps.location.lng());
}

int gpsFusionQualityTier(TinyGPSPlus& source) {
  if (!source.location.isValid() ||
      !source.satellites.isValid() ||
      !source.hdop.isValid() ||
      source.location.age() > gpsFixMaxAgeMs ||
      !isPlausibleTrackingCoordinate(source.location.lat(), source.location.lng())) {
    return 0;
  }

  int satellites = source.satellites.value();
  float hdop = normalizedGpsHdop(source);
  unsigned long age = source.location.age();

  if (satellites >= 10 && hdop <= 1.5 && age <= 1000UL) {
    return 3;
  }

  if (satellites >= 8 && hdop <= 2.5 && age <= 3000UL) {
    return 2;
  }

  if (satellites >= 6 && hdop <= 3.5 && age <= 5000UL) {
    return 1;
  }

  return 0;
}

float gpsAdaptiveFusionDistanceLimitMeters(TinyGPSPlus& first, TinyGPSPlus& second) {
  int weakerTier = min(gpsFusionQualityTier(first), gpsFusionQualityTier(second));

  if (weakerTier >= 3) {
    return 15.0;
  }

  if (weakerTier == 2) {
    return 20.0;
  }

  if (weakerTier == 1) {
    return 25.0;
  }

  return 0.0;
}

void printGpsSourceStatus(const char* label, TinyGPSPlus& source, bool usable) {
  Serial.print("[GPS] ");
  Serial.print(label);
  Serial.print(" usable=");
  Serial.print(usable ? "YES" : "NO");
  Serial.print(" sats=");
  Serial.print(source.satellites.isValid() ? source.satellites.value() : 0);
  Serial.print(" hdop=");
  if (source.hdop.isValid()) {
    Serial.print(source.hdop.hdop());
  } else {
    Serial.print("invalid");
  }
  Serial.print(" age=");
  Serial.print(source.location.isValid() ? source.location.age() : -1);
  Serial.print(" lat=");
  if (source.location.isValid()) {
    Serial.print(source.location.lat(), 6);
  } else {
    Serial.print("invalid");
  }
  Serial.print(" lon=");
  if (source.location.isValid()) {
    Serial.print(source.location.lng(), 6);
  } else {
    Serial.print("invalid");
  }
  Serial.print(" time=");
  Serial.print(gpsSourceTimestamp(source));
  Serial.print(" chars=");
  Serial.print(source.charsProcessed());
  Serial.print(" pass=");
  Serial.print(source.passedChecksum());
  Serial.print(" fail=");
  Serial.println(source.failedChecksum());
}

void printSelectedGpsStatus(const char* label) {
  Serial.print("[GPS] ");
  Serial.print(label);
  Serial.print(" sats=");
  Serial.print(gps_satellites);
  Serial.print(" hdop=");
  Serial.print(gps_hdop);
  Serial.print(" age=");
  Serial.print(gps_age);
  Serial.print(" lat=");
  Serial.print(gps_lat, 6);
  Serial.print(" lon=");
  Serial.print(gps_lon, 6);
  Serial.print(" trusted=");
  Serial.println(hasTrustedGpsQuality() ? "YES" : "NO");
}

void clearCurrentGpsFix() {
  gps_satellites = 0;
  gps_hdop = 0;
  gps_lat = 0.0;
  gps_lon = 0.0;
  gps_age = gpsFixMaxAgeMs + 1;
  gps_day = 0;
  gps_month = 0;
  gps_year = 0;
  gps_hour = 0;
  gps_minute = 0;
  gps_second = 0;
  gps_altitude = 0;
  gps_speed = 0;
  gps_course = -1;
  currentGpsFixIsHoldover = false;
  currentGpsTrustState = GPS_FAILED;
}

struct CachedGpsFix {
  bool valid;
  unsigned long storedAt;
  int satellites;
  float hdop;
  float lat;
  float lon;
  int age;
  int day;
  int month;
  int year;
  int hour;
  int minute;
  int second;
  int altitude;
  float course;
  int speed;
};

CachedGpsFix lastTrustedGpsFix = {false, 0, 0, 0.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -1};
CachedGpsFix lastPoorUsableGpsFix = {false, 0, 0, 0.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -1};

bool lastTrustedGpsFixStillFresh() {
  return lastTrustedGpsFix.valid &&
         millis() - lastTrustedGpsFix.storedAt <= gpsHoldLastFixGraceMs;
}

void rememberTrustedGpsFix() {
  if (currentGpsFixIsHoldover || !hasTrustedGpsQuality()) {
    return;
  }

  lastTrustedGpsFix.valid = true;
  lastTrustedGpsFix.storedAt = millis();
  lastTrustedGpsFix.satellites = gps_satellites;
  lastTrustedGpsFix.hdop = gps_hdop;
  lastTrustedGpsFix.lat = gps_lat;
  lastTrustedGpsFix.lon = gps_lon;
  lastTrustedGpsFix.age = gps_age;
  lastTrustedGpsFix.day = gps_day;
  lastTrustedGpsFix.month = gps_month;
  lastTrustedGpsFix.year = gps_year;
  lastTrustedGpsFix.hour = gps_hour;
  lastTrustedGpsFix.minute = gps_minute;
  lastTrustedGpsFix.second = gps_second;
  lastTrustedGpsFix.altitude = gps_altitude;
  lastTrustedGpsFix.course = gps_course;
  lastTrustedGpsFix.speed = gps_speed;
}

bool restoreLastTrustedGpsFixIfRecent(const char* reason) {
  if (!lastTrustedGpsFix.valid) {
    return false;
  }

  unsigned long fixAge = millis() - lastTrustedGpsFix.storedAt;
  if (fixAge > gpsHoldLastFixGraceMs) {
    Serial.print("[GPS] Last trusted fix too old for holdover: ");
    Serial.print(fixAge);
    Serial.println("ms");
    return false;
  }

  gps_satellites = lastTrustedGpsFix.satellites;
  gps_hdop = lastTrustedGpsFix.hdop;
  gps_lat = lastTrustedGpsFix.lat;
  gps_lon = lastTrustedGpsFix.lon;
  gps_age = min((unsigned long)(lastTrustedGpsFix.age + fixAge), gpsFixMaxAgeMs);
  gps_day = lastTrustedGpsFix.day;
  gps_month = lastTrustedGpsFix.month;
  gps_year = lastTrustedGpsFix.year;
  gps_hour = lastTrustedGpsFix.hour;
  gps_minute = lastTrustedGpsFix.minute;
  gps_second = lastTrustedGpsFix.second;
  gps_altitude = lastTrustedGpsFix.altitude;
  gps_course = lastTrustedGpsFix.course;
  gps_speed = lastTrustedGpsFix.speed;
  currentGpsFixIsHoldover = true;
  currentGpsTrustState = GPS_TRUSTED;

  Serial.print("[GPS] Using recent held fix after ");
  Serial.print(reason);
  Serial.print("; holdover age=");
  Serial.print(fixAge);
  Serial.println("ms");
  printSelectedGpsStatus("HELD FIX SELECTED");
  return true;
}

void rememberPoorUsableGpsFix() {
  if (!currentGpsFixIsPoorButUsable()) {
    return;
  }

  lastPoorUsableGpsFix.valid = true;
  lastPoorUsableGpsFix.storedAt = millis();
  lastPoorUsableGpsFix.satellites = gps_satellites;
  lastPoorUsableGpsFix.hdop = gps_hdop;
  lastPoorUsableGpsFix.lat = gps_lat;
  lastPoorUsableGpsFix.lon = gps_lon;
  lastPoorUsableGpsFix.age = gps_age;
  lastPoorUsableGpsFix.day = gps_day;
  lastPoorUsableGpsFix.month = gps_month;
  lastPoorUsableGpsFix.year = gps_year;
  lastPoorUsableGpsFix.hour = gps_hour;
  lastPoorUsableGpsFix.minute = gps_minute;
  lastPoorUsableGpsFix.second = gps_second;
  lastPoorUsableGpsFix.altitude = gps_altitude;
  lastPoorUsableGpsFix.course = gps_course;
  lastPoorUsableGpsFix.speed = gps_speed;
}

bool selectedGpsHasUsableTime() {
  return isValidDateTime(gps_day, gps_month, gps_year) &&
         gps_hour >= 0 && gps_hour <= 23 &&
         gps_minute >= 0 && gps_minute <= 59 &&
         gps_second >= 0 && gps_second <= 59;
}

bool selectedPoorGpsJumpIsPlausible() {
  static bool hasPreviousPoorCandidate = false;
  static float previousPoorLat = 0.0;
  static float previousPoorLon = 0.0;
  static unsigned long previousPoorAt = 0;
  static uint8_t consecutivePoorCandidates = 0;

  unsigned long now = millis();

  if (!isPlausibleTrackingCoordinate(gps_lat, gps_lon) ||
      !selectedGpsHasUsableTime() ||
      gps_age < 0 ||
      gps_age > gpsFixMaxAgeMs) {
    consecutivePoorCandidates = 0;
    return false;
  }

  if (hasPreviousPoorCandidate) {
    unsigned long elapsedMs = now - previousPoorAt;
    if (elapsedMs < 1000UL) {
      elapsedMs = 1000UL;
    }

    float distanceMeters = gps.distanceBetween(gps_lat, gps_lon, previousPoorLat, previousPoorLon);
    float impliedKmph = (distanceMeters / 1000.0) / (elapsedMs / 3600000.0);

    bool absurdShortJump = elapsedMs <= 10000UL && distanceMeters > 500.0;
    bool absurdMediumJump = elapsedMs <= 20000UL && distanceMeters > 1000.0;
    bool absurdSpeed = impliedKmph > 250.0;

    if (absurdShortJump || absurdMediumJump || absurdSpeed) {
      Serial.print("[GPS] Poor fix rejected; jump distance=");
      Serial.print(distanceMeters);
      Serial.print("m elapsed=");
      Serial.print(elapsedMs);
      Serial.print("ms speed=");
      Serial.print(impliedKmph);
      Serial.println("km/h");
      consecutivePoorCandidates = 0;
      previousPoorLat = gps_lat;
      previousPoorLon = gps_lon;
      previousPoorAt = now;
      return false;
    }
  }

  previousPoorLat = gps_lat;
  previousPoorLon = gps_lon;
  previousPoorAt = now;
  hasPreviousPoorCandidate = true;

  if (consecutivePoorCandidates < poorGpsRequiredConsecutiveReadings) {
    consecutivePoorCandidates++;
  }

  if (consecutivePoorCandidates < poorGpsRequiredConsecutiveReadings) {
    Serial.print("[GPS] Poor fix plausible but waiting for stability ");
    Serial.print(consecutivePoorCandidates);
    Serial.print("/");
    Serial.println(poorGpsRequiredConsecutiveReadings);
    return false;
  }

  return true;
}

bool acceptSelectedPoorGpsIfStable(const char* reason) {
  if (hasTrustedGpsQuality()) {
    currentGpsTrustState = GPS_TRUSTED;
    return true;
  }

  if (!selectedPoorGpsJumpIsPlausible()) {
    return false;
  }

  currentGpsTrustState = GPS_POOR_BUT_USABLE;

  // R16: GPS quality is not vehicle motion state. A poor-but-usable fix may
  // still belong to a vehicle that the GNSS filter has already confirmed as
  // MOVING. Only clamp to the stationary anchor when the filter itself says
  // the stationary lock is active.
  if (R11Filter::authoritativeVehicleStationary()) {
    vehicle_state = "STATIONARY";
    clampSelectedFixToStationaryAnchor("poor-but-usable stationary fix");
  } else if (R11Filter::authoritativeVehicleMoving()) {
    vehicle_state = "MOVING";
  }

  rememberPoorUsableGpsFix();

  Serial.print("[GPS] Poor-but-usable fix accepted after ");
  Serial.println(reason);
  printSelectedGpsStatus("POOR BUT USABLE SELECTED");
  return true;
}

void discardCurrentGpsFix(const char* reason) {
  Serial.print("Discarding GPS fix: ");
  Serial.println(reason);
  if (!restoreLastTrustedGpsFixIfRecent(reason)) {
    clearCurrentGpsFix();
  }
}

String gpsSourceTimestamp(TinyGPSPlus& source) {
  if (!source.date.isValid() || !source.time.isValid()) {
    return "";
  }

  return createDate(
    source.date.day(),
    source.date.month(),
    source.date.year(),
    source.time.hour(),
    source.time.minute(),
    source.time.second()
  );
}

bool gpsSourceHasUsableClock(TinyGPSPlus& source) {
  return source.date.isValid() &&
         source.time.isValid() &&
         isValidDateTime(source.date.day(), source.date.month(), source.date.year());
}

void applyGpsClockFromSource(TinyGPSPlus& source) {
  gps_day = source.date.day();
  gps_month = source.date.month();
  gps_year = source.date.year();
  gps_hour = source.time.hour();
  gps_minute = source.time.minute();
  gps_second = source.time.second();
}

void applyPreferredGpsClockToSelectedFix() {
  if (gpsSourceHasUsableClock(neoGPS)) {
    applyGpsClockFromSource(neoGPS);
    Serial.println("[GPS] NEO-6 clock selected for GPS timestamp");
    return;
  }

  if (selectedGpsHasUsableTime()) {
    return;
  }

  if (gpsSourceHasUsableClock(gps)) {
    applyGpsClockFromSource(gps);
    Serial.println("[GPS] A7670 clock selected for GPS timestamp");
  }
}

String gpsSourceLocationKey(TinyGPSPlus& source) {
  String sourceTimestamp = gpsSourceTimestamp(source);
  if (sourceTimestamp.length() == 0 || !source.location.isValid()) {
    return "";
  }

  return sourceTimestamp + "|" + String(source.location.lat(), 6) + "|" + String(source.location.lng(), 6);
}

bool a7670HasOneShotStaleLocationCandidate() {
  return gps.location.isValid() &&
         gps.location.age() > gpsFixMaxAgeMs &&
         gps.location.age() <= staleGpsOneShotMaxAgeMs &&
         isPlausibleTrackingCoordinate(gps.location.lat(), gps.location.lng()) &&
         gpsSourceHasUsableClock(gps);
}

bool selectA7670OneShotStaleLocationFallback() {
  // R16: never pull a confirmed-moving vehicle back to an old A7670 location.
  // During movement, an invalid/held row is safer than a stale coordinate that
  // can be hundreds or thousands of metres behind the vehicle.
  if (R11Filter::authoritativeVehicleMoving()) {
    Serial.println("[GPS] A7670 stale one-shot suppressed while R16 state=MOVING");
    return false;
  }

  if (!a7670HasOneShotStaleLocationCandidate()) {
    return false;
  }

  String staleKey = gpsSourceLocationKey(gps);
  if (staleKey.length() == 0 || staleKey == lastReportedStaleA7670Key) {
    Serial.println("[GPS] A7670 stale coordinate already used once; ignoring repeat");
    return false;
  }

  lastReportedStaleA7670Key = staleKey;
  Serial.println("[GPS] A7670 stale coordinate used once as last-known low-confidence fallback");
  gps_satellites = gps.satellites.isValid() ? gps.satellites.value() : 0;
  gps_hdop = normalizedGpsHdop(gps);
  gps_lat = gps.location.lat();
  gps_lon = gps.location.lng();
  gps_age = gps.location.age();
  applyGpsClockFromSource(gps);
  applyPreferredGpsClockToSelectedFix();
  gps_altitude = gps.altitude.isValid() ? round(gps.altitude.meters()) : 0;
  gps_course = sanitizedGpsCourse(gps);
  gps_speed = 0;
  currentGpsTrustState = GPS_STALE_ONE_SHOT;
  if (R11Filter::authoritativeVehicleStationary()) {
    vehicle_state = "STATIONARY";
  }
  printSelectedGpsStatus("A7670 STALE ONE-SHOT SELECTED");
  return true;
}

float gpsSourceDistanceMeters(TinyGPSPlus& first, TinyGPSPlus& second) {
  if (!first.location.isValid() || !second.location.isValid()) {
    return 999999.0;
  }

  return first.distanceBetween(
    first.location.lat(),
    first.location.lng(),
    second.location.lat(),
    second.location.lng()
  );
}

void updateA7670SerialProgress() {
  uint32_t currentChars = gps.charsProcessed();
  if (currentChars != lastA7670CharsProcessed) {
    lastA7670CharsProcessed = currentChars;
    lastA7670SerialProgressAt = millis();
  }
}

bool a7670ShowsGnssFixProgress() {
  if (!gps.satellites.isValid() || gps.satellites.value() <= 0) {
    return false;
  }

  if (gps.location.isValid() && gps.location.age() <= gpsFixMaxAgeMs) {
    return true;
  }

  if (!gps.hdop.isValid()) {
    return true;
  }

  float hdop = gps.hdop.hdop();
  return hdop > 0.0 && hdop < 99.0;
}

bool a7670RecoveryAllowed(bool neoSourceUsable) {
  unsigned long now = millis();

  if (lastA7670RecoveryAt != 0 && now - lastA7670RecoveryAt < a7670RecoveryCooldownMs) {
    Serial.println("[GNSS] A7670 recovery suppressed; cooldown active");
    return false;
  }

  if (neoSourceUsable &&
      lastA7670SerialProgressAt != 0 &&
      now - lastA7670SerialProgressAt < a7670SerialProgressGraceMs) {
    if (a7670ShowsGnssFixProgress()) {
      Serial.println("[GNSS] A7670 recovery deferred; modem GNSS fix is still progressing");
      return false;
    }

    Serial.println("[GNSS] A7670 serial is progressing but fix is dead; recovery allowed");
  }

  lastA7670RecoveryAt = now;
  return true;
}

void resetA7670BadReadingStreak() {
  a7670BadStreakStartedAt = 0;
  a7670BadStreakLastAt = 0;
  a7670ConsecutiveBadReadings = 0;
  gpsCount = 0;
}

void noteA7670BadReadingStreak(bool verbose) {
  unsigned long now = millis();

  if (a7670BadStreakStartedAt == 0 || a7670ConsecutiveBadReadings == 0) {
    a7670BadStreakStartedAt = now;
    if (verbose) {
      Serial.println("[GNSS] A7670 bad/stale streak started");
    }
  }

  a7670BadStreakLastAt = now;
  if (a7670ConsecutiveBadReadings < 65535) {
    a7670ConsecutiveBadReadings++;
  }
  gpsCount = a7670ConsecutiveBadReadings;
}

bool a7670BadReadingStreakReadyForRecovery() {
  if (a7670BadStreakStartedAt == 0) {
    return false;
  }

  return a7670ConsecutiveBadReadings >= a7670RecoveryBadReadingThreshold &&
         millis() - a7670BadStreakStartedAt >= a7670RecoveryMinBadStreakMs;
}

void printA7670BadReadingStreakStatus() {
  unsigned long badStreakAgeSeconds = 0;
  if (a7670BadStreakStartedAt != 0) {
    badStreakAgeSeconds = (millis() - a7670BadStreakStartedAt) / 1000UL;
  }

  Serial.print("[GNSS] A7670 bad/stale streak age=");
  Serial.print(badStreakAgeSeconds);
  Serial.print("s readings=");
  Serial.print(a7670ConsecutiveBadReadings);
  Serial.print("/");
  Serial.print(a7670RecoveryBadReadingThreshold);
  Serial.print(" requiredAge=");
  Serial.print(a7670RecoveryMinBadStreakMs / 1000UL);
  Serial.println("s");
}

bool gpsSourceHasFreshData(TinyGPSPlus& source, bool isNeoSource) {
  static String lastA7670Timestamp = "";
  static String lastNeoTimestamp = "";
  static unsigned long lastA7670TimestampChangedAt = 0;
  static unsigned long lastNeoTimestampChangedAt = 0;
  const unsigned long maxUnchangedGpsTimestampMs = 90000UL;

  if (!source.location.isValid() ||
      source.location.age() > gpsFixMaxAgeMs) {
    return false;
  }

  if (isNeoSource && (!source.satellites.isValid() || source.satellites.value() <= 0)) {
    return false;
  }

  String sourceTimestamp = gpsSourceTimestamp(source);
  if (sourceTimestamp.length() == 0) {
    return false;
  }

  String& lastTimestamp = isNeoSource ? lastNeoTimestamp : lastA7670Timestamp;
  unsigned long& lastTimestampChangedAt = isNeoSource ? lastNeoTimestampChangedAt : lastA7670TimestampChangedAt;

  if (lastTimestamp != sourceTimestamp) {
    lastTimestamp = sourceTimestamp;
    lastTimestampChangedAt = millis();
    return true;
  }

  if (lastTimestampChangedAt == 0) {
    lastTimestampChangedAt = millis();
  }

  return millis() - lastTimestampChangedAt <= maxUnchangedGpsTimestampMs;
}

static String a7670CompactAtResponse(String response) {
  response.replace("\r", "");
  response.replace("\n", " | ");
  response.trim();
  while (response.indexOf("  ") >= 0) response.replace("  ", " ");
  if (response.length() > 420) {
    response = response.substring(0, 420) + "...";
  }
  return response;
}

static String a7670RawAt(const char* command, unsigned long timeoutMs) {
  A7670NmeaDiag::resetLineAssembly();
  clearModemSerial();
  Serial1.print("AT");
  Serial1.print(command);
  Serial1.print("\r");
  String response = readModemSerialFor(timeoutMs);
  return response;
}

static void printA7670AtDiagnostic(const char* label, const char* command,
                                   unsigned long timeoutMs = 1400UL) {
  String response = a7670RawAt(command, timeoutMs);
  Serial.print("[A7670-AT] ");
  Serial.print(label);
  Serial.print(" CMD=AT");
  Serial.print(command);
  Serial.print(" RESP=");
  Serial.println(a7670CompactAtResponse(response));
}

static int parseA7670GnssPowerStatus(const String& response) {
  int pos = response.indexOf("+CGNSSPWR:");
  if (pos < 0) return -1;
  pos += 11;
  while (pos < (int)response.length() &&
         (response[pos] == ' ' || response[pos] == '\t')) pos++;
  if (pos >= (int)response.length()) return -1;
  if (response[pos] == '0') return 0;
  if (response[pos] == '1') return 1;
  return -1;
}

static int queryA7670GnssPowerStatus(bool printResult = true) {
  String response = a7670RawAt("+CGNSSPWR?", 1600UL);
  int status = parseA7670GnssPowerStatus(response);
  if (printResult) {
    Serial.print("[A7670-AT] POWER_STATUS=");
    Serial.print(status);
    Serial.print(" RESP=");
    Serial.println(a7670CompactAtResponse(response));
  }
  return status;
}

static bool setA7670GnssPowerRaw(bool enable) {
  const char* command = enable ? "+CGNSSPWR=1" : "+CGNSSPWR=0";
  String response = a7670RawAt(command, 3500UL);
  Serial.print("[A7670-AT] POWER_SET=");
  Serial.print(enable ? 1 : 0);
  Serial.print(" RESP=");
  Serial.println(a7670CompactAtResponse(response));

  // Do not depend on one specific URC. Verify the actual modem state.
  // This specifically avoids the older enableGPS() false-negative path where
  // +CGNSSPWR: READY! was required even if the engine was already powered.
  int requestedStatus = enable ? 1 : 0;
  int status = -1;
  for (uint8_t attempt = 1; attempt <= 10; ++attempt) {
    delay(attempt == 1 ? 500UL : 1000UL);
    status = queryA7670GnssPowerStatus(attempt == 1 || attempt == 10);
    if (status == requestedStatus) break;
    kickWatchdog();
    yield();
  }

  bool verified = status == requestedStatus;
  Serial.print("EVENT,A7670_GNSS_POWER_VERIFY,REQUESTED,");
  Serial.print(enable ? 1 : 0);
  Serial.print(",VERIFIED,");
  Serial.println(verified ? 1 : 0);
  return verified;
}

// R19.1: raw NMEA mirroring and full AT snapshots are forensic tools, not
// prerequisites for normal GNSS acquisition. Keep them available but off by
// default to reduce serial load and avoid long blocking diagnostic sequences.
constexpr bool A7670_RAW_NMEA_CAPTURE_ENABLED = false;
constexpr bool A7670_FULL_RECOVERY_DIAGNOSTIC_ENABLED = false;

bool ensureA7670GnssPowerOn(const char* reason) {
  Serial.print("[A7670-GNSS] ensure power ON reason=");
  Serial.println(reason);
  int status = queryA7670GnssPowerStatus(true);
  if (status == 1) {
    Serial.println("EVENT,A7670_GNSS_POWER_ALREADY_ON");
    return true;
  }

  bool ok = setA7670GnssPowerRaw(true);
  Serial.print("EVENT,A7670_GNSS_POWER_ON_RESULT,OK,");
  Serial.println(ok ? 1 : 0);
  return ok;
}

void diagnoseA7670GnssState(const char* reason, bool restoreNmea) {
  Serial.print("[A7670-DIAG] SNAPSHOT_BEGIN reason=");
  Serial.println(reason);

  bool disableOk = modem.disableNMEA();
  delay(250);
  A7670NmeaDiag::resetLineAssembly();
  clearModemSerial();
  Serial.print("[A7670-DIAG] NMEA_DISABLE_FOR_SNAPSHOT=");
  Serial.println(disableOk ? 1 : 0);

  queryA7670GnssPowerStatus(true);
  printA7670AtDiagnostic("MODE", "+CGNSSMODE?");
  printA7670AtDiagnostic("NMEA_MASK", "+CGNSSNMEA?");
  printA7670AtDiagnostic("NMEA_RATE", "+CGPSNMEARATE?");
  printA7670AtDiagnostic("NMEA_TEST", "+CGNSSTST?");
  printA7670AtDiagnostic("NMEA_PORT", "+CGNSSPORTSWITCH?");
  printA7670AtDiagnostic("GNSS_INFO", "+CGNSSINFO", 2200UL);
  printA7670AtDiagnostic("GNSS_PRODUCT", "+CGNSSPROD", 2200UL);

  if (restoreNmea) {
    bool restoreOk = modem.enableNMEA();
    Serial.print("[A7670-DIAG] NMEA_RESTORE_AFTER_SNAPSHOT=");
    Serial.println(restoreOk ? 1 : 0);
    if (A7670_RAW_NMEA_CAPTURE_ENABLED) {
      A7670NmeaDiag::armRawCapture(15000UL);
    }
  }
  Serial.print("[A7670-DIAG] SNAPSHOT_END reason=");
  Serial.println(reason);
}

void configureA7670GpsOutput() {
  bool baudOk = modem.setGPSBaud(115200);
  bool modeOk = modem.setGPSMode(3);
  bool sentenceOk = modem.configNMEASentence(1, 1, 1, 1, 1, 1);
  bool rateOk = modem.setGPSOutputRate(1);
  bool nmeaOk = modem.enableNMEA();

  Serial.print("EVENT,A7670_CONFIG_RESULT,BAUD,");
  Serial.print(baudOk ? 1 : 0);
  Serial.print(",MODE,");
  Serial.print(modeOk ? 1 : 0);
  Serial.print(",NMEA_MASK,");
  Serial.print(sentenceOk ? 1 : 0);
  Serial.print(",RATE,");
  Serial.print(rateOk ? 1 : 0);
  Serial.print(",OUTPUT,");
  Serial.println(nmeaOk ? 1 : 0);

  if (A7670_RAW_NMEA_CAPTURE_ENABLED) {
    A7670NmeaDiag::armRawCapture(15000UL);
  }
  startGnssProtectionWindow();
}

void recoverA7670GpsOutput() {
  Serial.println("Recovering A7670 GNSS/NMEA output");
  bool nmeaDisableOk = modem.disableNMEA();
  delay(250);
  A7670NmeaDiag::resetLineAssembly();
  clearModemSerial();
  resetA7670GpsParserState();

  Serial.print("[A7670-RECOVERY] NMEA_DISABLE=");
  Serial.println(nmeaDisableOk ? 1 : 0);
  if (A7670_FULL_RECOVERY_DIAGNOSTIC_ENABLED) {
    diagnoseA7670GnssState("RECOVERY_PRE", false);
  }

  int powerStatus = queryA7670GnssPowerStatus(true);
  bool powerReady = false;

  // R14-R17 called enableGPS() repeatedly. TinyGSM waits specifically for
  // +CGNSSPWR: READY!, which can report false if the GNSS engine is already
  // powered. A five-minute dead-fix condition with power already ON needs a
  // real GNSS power cycle rather than another enable request.
  if (powerStatus == 1) {
    Serial.println("EVENT,A7670_RECOVERY_ACTION,FULL_GNSS_POWER_CYCLE,REASON,POWER_ON_FIX_DEAD");
    bool offOk = setA7670GnssPowerRaw(false);
    if (offOk) {
      powerReady = setA7670GnssPowerRaw(true);
    } else {
      Serial.println("EVENT,A7670_RECOVERY_ACTION,POWER_OFF_VERIFY_FAILED");
      powerReady = queryA7670GnssPowerStatus(true) == 1;
    }
  } else {
    Serial.println("EVENT,A7670_RECOVERY_ACTION,GNSS_POWER_ON,REASON,POWER_OFF_OR_UNKNOWN");
    powerReady = setA7670GnssPowerRaw(true);
  }

  if (!powerReady) {
    Serial.println("FAILED TO VERIFY A7670 GNSS POWER");
  } else {
    Serial.println("[A7670-RECOVERY] GNSS power verified ON");
  }

  configureA7670GpsOutput();
  if (A7670_FULL_RECOVERY_DIAGNOSTIC_ENABLED) {
    diagnoseA7670GnssState("RECOVERY_POST_CONFIG", true);
  }
  resetA7670GpsParserState();
  feedGpsParsers(500);
  A7670NmeaDiag::printSummary("recovery_command_complete");
  Serial.println("A7670 GNSS/NMEA recovery command sequence complete");
}

bool applyR11ProcessedGpsToTracker() {
  if (!R11Filter::hasProcessedOutput()) {
    return false;
  }

  const R11Filter::ProcessedGpsOutput& out = R11Filter::latestOutput();
  gps_satellites = out.satellites;
  gps_hdop = isfinite(out.hdop) ? out.hdop : 0.0f;
  gps_lat = (float)out.lat;
  gps_lon = (float)out.lon;

  unsigned long elapsedSinceProcessed = millis() - out.updatedAtMs;
  unsigned long processedAge = (unsigned long)out.sourceAgeMs + elapsedSinceProcessed;
  gps_age = processedAge > 2147483647UL ? 2147483647 : (int)processedAge;

  gps_altitude = isfinite(out.altitudeM) ? (int)round(out.altitudeM) : 0;
  gps_course = isfinite(out.courseDeg) ? out.courseDeg : -1.0f;
  gps_speed = isfinite(out.speedKmh) ? (int)round(out.speedKmh) : 0;
  currentGpsFixIsHoldover = false;
  return isPlausibleTrackingCoordinate(gps_lat, gps_lon);
}

static void processTrackingData(bool allowCriticalWork, bool verbose, unsigned long parserBudgetMs) {
  if (verbose) {
    Serial.println("GET TRACKING DATA");
  }

  feedGpsParsers(parserBudgetMs);
  updateA7670SerialProgress();

  // Raw parser state remains only for receiver health and the existing A7670 recovery logic.
  // Application GPS fields below are supplied by the R11 processed output.
  bool a7670SourceFresh = gpsSourceHasFreshData(gps, false);
  bool neoSourceFresh = gpsSourceHasFreshData(neoGPS, true);
  int a7670ReliabilityScore = gpsSourceReliabilityScore(gps);
  int neoReliabilityScore = gpsSourceReliabilityScore(neoGPS);
  bool a7670SourceUsable = a7670SourceFresh && a7670ReliabilityScore > 0;
  bool neoSourceUsable = neoSourceFresh && neoReliabilityScore > 0 && neoGPS.satellites.value() > 0;
  is_location_valid = a7670SourceUsable;
  is_location_valid2 = neoSourceUsable;

  if (verbose) {
    printGpsSourceStatus("A7670", gps, a7670SourceUsable);
    printGpsSourceStatus("NEO-6", neoGPS, neoSourceUsable);
  }

  datetime = "";
  bool haveProcessedGps = applyR11ProcessedGpsToTracker();

  if (haveProcessedGps) {
    applyPreferredGpsClockToSelectedFix();

    if (isValidDateTime(gps_day, gps_month, gps_year)) {
      datetime = localDateTimeStringFromUtc(gps_day, gps_month, gps_year, gps_hour, gps_minute, gps_second);
    }

    if (hasTrustedGpsQuality()) {
      currentGpsTrustState = GPS_TRUSTED;
      rememberTrustedGpsFix();
      if (allowCriticalWork) {
        commands();
      }
    } else if (!acceptSelectedPoorGpsIfStable("R11 processed low-confidence fix")) {
      if (!restoreLastTrustedGpsFixIfRecent("R11 processed GPS quality temporarily below tracker trust threshold")) {
        clearCurrentGpsFix();
      }
    }
  } else {
    if (!restoreLastTrustedGpsFixIfRecent("R11 has no processed GPS output yet")) {
      clearCurrentGpsFix();
    }
  }

  if (allowCriticalWork && hasSendableGpsQuality()) {
    String selectedClockDate = createDate(gps_day, gps_month, gps_year, gps_hour, gps_minute, gps_second);
    uint32_t selectedClockEpoch = epochFromDateString(selectedClockDate);
    if (gpsClockEpochIsAcceptable(selectedClockEpoch, "selected RT GPS")) {
      persistGpsClockEpoch(selectedClockEpoch, false);
    }
  }

  // Preserve the existing A7670 bad/stale streak recovery behavior.
  if (a7670SourceUsable) {
    resetA7670BadReadingStreak();
  } else {
    noteA7670BadReadingStreak(verbose && allowCriticalWork);
  }

  if (!a7670SourceUsable && allowCriticalWork) {
    Serial.println("A7670E GNSS DATA INVALID, STALE, OR STAGNATED");
    Serial.println("GPS COUNT: " + String(gpsCount));
    printA7670BadReadingStreakStatus();
    if (a7670BadReadingStreakReadyForRecovery()) {
      if (a7670RecoveryAllowed(neoSourceUsable)) {
        Serial.println("ENABLING GNSS");
        recoverA7670GpsOutput();
      }
      resetA7670BadReadingStreak();
    }
  }

  if (allowCriticalWork && ((!is_location_valid && !is_location_valid2) || vehicle_state == "STATIONARY")) {
    if (verbose) {
      Serial.println("Offline replay deferred to scheduler.");
    }
  }

  oldDatetime = datetime;
  if (verbose) {
    Serial.println("NO GNSS GPS COUNT: " + String(gpsCount));
  }
}

static void getTrackingData () {
  Serial.println("GET TRACKING DATA");
  processTrackingData(true, true, 10);
}

void sampleGpsTrackingDataOnly() {
  processTrackingData(false, false, 10);
  // R16 motion authority remains meaningful through temporary GPS-quality
  // degradation, so synchronize state even when the current fix is poor.
  updateVehicleStateFromGps();
}


bool isValidDateTime(int day, int month, int year) {
  return day > 0 && day <= 31 && month > 0 && month <= 12 && year >= 2020 && year <= 2035;
}

String twoDigits(int value) {
  if (value < 10) {
    return "0" + String(value);
  }
  return String(value);
}

String createDate(int day, int month, int year, int hour, int minute, int second) {
  if (!isValidDateTime(day, month, year) ||
      hour < 0 || hour > 23 ||
      minute < 0 || minute > 59 ||
      second < 0 || second > 59) {
    return "";
  }
  return twoDigits(month) + "/" + twoDigits(day) + "/" + String(year) + " " + twoDigits(hour) + ":" + twoDigits(minute) + ":" + twoDigits(second) + " GMT"; // MM/DD/YYYY HH:MM:SS
}

String getNetworkDate() {
  String resp = sendAT("AT+CCLK?", 1500);
  int quoteStart = resp.indexOf('"');
  int quoteEnd = resp.indexOf('"', quoteStart + 1);
  if (quoteStart == -1 || quoteEnd == -1) {
    return "";
  }

  String modemTime = resp.substring(quoteStart + 1, quoteEnd);
  if (modemTime.length() < 17) {
    return "";
  }

  int year = modemTime.substring(0, 2).toInt() + 2000;
  int month = modemTime.substring(3, 5).toInt();
  int day = modemTime.substring(6, 8).toInt();
  int hour = modemTime.substring(9, 11).toInt();
  int minute = modemTime.substring(12, 14).toInt();
  int second = modemTime.substring(15, 17).toInt();
  int timezoneOffsetMinutes = 0;
  bool hasTimezoneOffset = false;

  if (modemTime.length() >= 20) {
    char signChar = modemTime.charAt(17);
    if (signChar == '+' || signChar == '-') {
      int quarterHours = modemTime.substring(18).toInt();
      timezoneOffsetMinutes = quarterHours * 15;
      if (signChar == '-') {
        timezoneOffsetMinutes = -timezoneOffsetMinutes;
      }
      hasTimezoneOffset = true;
      setLocalTimezoneOffsetMinutes(timezoneOffsetMinutes, "network clock");
    }
  }

  if (!isValidDateTime(day, month, year)) {
    Serial.print("Ignoring invalid modem clock: ");
    Serial.println(modemTime);
    return "";
  }

  if (hasTimezoneOffset) {
    uint32_t utcEpoch = utcEpochFromLocalDateTime(day, month, year, hour, minute, second, timezoneOffsetMinutes);
    return dateStringFromEpoch(utcEpoch);
  }

  return createDate(day, month, year, hour, minute, second);
}

String clockDateFromGpsParser(TinyGPSPlus& source) {
  if (!source.date.isValid() || !source.time.isValid()) {
    return "";
  }

  return createDate(
    source.date.day(),
    source.date.month(),
    source.date.year(),
    source.time.hour(),
    source.time.minute(),
    source.time.second()
  );
}

String bestAvailableClockDate() {
  String neoClockDate = clockDateFromGpsParser(neoGPS);
  if (neoClockDate.length() > 0) {
    return neoClockDate;
  }

  String selectedGpsDate = createDate(gps_day, gps_month, gps_year, gps_hour, gps_minute, gps_second);
  if (selectedGpsDate.length() > 0) {
    return selectedGpsDate;
  }

  String a7670ClockDate = clockDateFromGpsParser(gps);
  if (a7670ClockDate.length() > 0) {
    return a7670ClockDate;
  }

  return "";
}

String createNoGpsDate() {
  static String lastUsableGpsClockDate = "";
  static uint32_t lastUsableGpsClockEpoch = 0;
  static unsigned long lastUsableGpsClockAtMs = 0;

  String gpsClockDate = bestAvailableClockDate();
  if (gpsClockDate.length() > 0) {
    uint32_t gpsClockEpoch = epochFromDateString(gpsClockDate);
    if (gpsClockEpochIsAcceptable(gpsClockEpoch, "GPS fallback date")) {
      lastUsableGpsClockDate = gpsClockDate;
      lastUsableGpsClockEpoch = gpsClockEpoch;
      lastUsableGpsClockAtMs = millis();
      persistGpsClockEpoch(lastUsableGpsClockEpoch, false);
      return gpsClockDate;
    }
  }

  if (lastUsableGpsClockEpoch != 0 && lastUsableGpsClockAtMs != 0) {
    uint32_t estimatedEpoch = lastUsableGpsClockEpoch + ((millis() - lastUsableGpsClockAtMs) / 1000UL);
    if (gpsClockEpochIsAcceptable(estimatedEpoch, "estimated GPS fallback date")) {
      return dateStringFromEpoch(estimatedEpoch);
    }
  }

  if (lastUsableGpsClockDate.length() > 0) {
    uint32_t lastUsableEpoch = epochFromDateString(lastUsableGpsClockDate);
    if (gpsClockEpochIsAcceptable(lastUsableEpoch, "last usable GPS fallback date")) {
      return lastUsableGpsClockDate;
    }
  }

  String persistedGpsDate = lastPersistedGpsClockDate();
  if (persistedGpsDate.length() > 0) {
    return persistedGpsDate;
  }

  return "01/01/2026 00:00:00 GMT";
}

void updateVehicleStateFromGps() {
  static uint8_t movingEvidenceCount = 0;
  static uint8_t stationaryEvidenceCount = 0;
  static unsigned long movingEvidenceStartedAt = 0;
  static bool hasStationaryReferenceAltitude = false;
  static int stationaryReferenceAltitude = 0;
  static String lastReportedVehicleState = "";

  bool hasCurrentLocation = isPlausibleTrackingCoordinate(gps_lat, gps_lon);
  bool filterStateKnown = R11Filter::authoritativeMotionStateKnown();
  bool filterMoving = R11Filter::authoritativeVehicleMoving();
  bool filterStationary = R11Filter::authoritativeVehicleStationary();

  bool usingStationaryAnchor = filterStationary && stationaryGpsAnchor.valid;
  float referenceLat = usingStationaryAnchor ? stationaryGpsAnchor.lat : lastlat;
  float referenceLon = usingStationaryAnchor ? stationaryGpsAnchor.lon : lastlon;
  bool hasPreviousLocation = referenceLat != 0.0 && referenceLon != 0.0;

  distance_between = 0;
  if (hasCurrentLocation && hasPreviousLocation) {
    distance_between = gps.distanceBetween(gps_lat, gps_lon, referenceLat, referenceLon);
  }

  bool goodFix = hasTrustedGpsQuality();
  int speedThreshold = gpsMovementSpeedThresholdKmph(gps_satellites, gps_hdop);
  float distanceThreshold = gpsMovementDistanceThresholdMeters(gps_satellites, gps_hdop);
  float stationaryAnchorGate = usingStationaryAnchor ? stationaryGpsAnchorGateMeters() : 0.0;
  float stationaryDistanceGate = usingStationaryAnchor
                                 ? maxFloatValue(stationaryAnchorGate, distanceThreshold)
                                 : distanceThreshold;
  bool speedSupportsMoving = gps_speed >= speedThreshold;
  bool distanceSupportsMoving = hasPreviousLocation &&
                                distance_between > stationaryDistanceGate;
  bool outsideClusterConfirmed = usingStationaryAnchor &&
                                 stationaryOutsideClusterIsConfirmed(stationaryAnchorGate);
  bool speedOnlyMovement = speedSupportsMoving &&
                           !distanceSupportsMoving &&
                           !outsideClusterConfirmed;
  bool altitudeUnstable = vehicle_state == "STATIONARY" &&
                          hasStationaryReferenceAltitude &&
                          abs(gps_altitude - stationaryReferenceAltitude) > 120;
  bool stationaryAnchorRejectsDrift = usingStationaryAnchor &&
                                      distance_between > stationaryAnchorGate &&
                                      !stationaryOutsideClusterIsConfirmed(stationaryAnchorGate);
  bool movementDetected = goodFix &&
                          !stationaryAnchorRejectsDrift &&
                          !speedOnlyMovement &&
                          !altitudeUnstable &&
                          gpsMotionIndicatesMoving(
                            gps_speed,
                            (float)distance_between,
                            gps_satellites,
                            gps_hdop,
                            hasPreviousLocation
                          );
  unsigned long now = millis();

  // ----------------------------------------------------------
  // R16 SINGLE AUTHORITATIVE MOTION STATE
  // ----------------------------------------------------------
  // Once the GNSS filter has an explicit stationary lock or has explicitly
  // released that lock for real movement, no downstream quality/holdover
  // branch is allowed to independently reverse that decision.
  if (filterStateKnown) {
    String authoritativeState = filterMoving ? "MOVING" : "STATIONARY";

    if (vehicle_state != authoritativeState) {
      Serial.print("[GPS] R16 motion authority override ");
      Serial.print(vehicle_state);
      Serial.print(" -> ");
      Serial.print(authoritativeState);
      Serial.print(" filter_stage=");
      Serial.println(R11Filter::stageName());
    }

    vehicle_state = authoritativeState;
    movingEvidenceCount = 0;
    stationaryEvidenceCount = 0;
    movingEvidenceStartedAt = 0;

    if (filterMoving) {
      hasStationaryReferenceAltitude = false;
      if (stationaryGpsAnchor.valid) {
        resetStationaryGpsAnchor("R16 filter movement authority");
      }
    }

    if (goodFix) {
      if (filterStationary && stationaryGpsAnchor.valid) {
        lastlat = stationaryGpsAnchor.lat;
        lastlon = stationaryGpsAnchor.lon;
        if (!hasStationaryReferenceAltitude || gps_speed == 0) {
          stationaryReferenceAltitude = gps_altitude;
          hasStationaryReferenceAltitude = true;
        }
      } else {
        lastlat = gps_lat;
        lastlon = gps_lon;
      }
    }
  } else {
    // --------------------------------------------------------
    // BOOT/SEARCH FALLBACK ONLY
    // --------------------------------------------------------
    // Before the filter has acquired either a stationary lock or a MOVING
    // release state, retain the legacy detector for vehicles that boot while
    // already moving. Crucially, poor GPS quality is UNKNOWN evidence: it
    // cannot increment stationary evidence or turn MOVING into STATIONARY.
    if (!goodFix) {
      movingEvidenceCount = 0;
      movingEvidenceStartedAt = 0;
      stationaryEvidenceCount = 0;
    } else if (vehicle_state == "STATIONARY" && movementDetected) {
      if (movingEvidenceCount == 0) {
        movingEvidenceStartedAt = now;
      }
      movingEvidenceCount++;
      stationaryEvidenceCount = 0;
      bool strongSpeedEvidence = gps_speed >= speedThreshold + 4;
      bool distanceBackedEvidence = distanceSupportsMoving || outsideClusterConfirmed;
      bool sustainedEvidence = movingEvidenceCount >= stationaryExitMovingConfirmations &&
                               now - movingEvidenceStartedAt >= stationaryExitEvidenceMinMs;
      bool fastDistanceBackedEvidence = strongSpeedEvidence &&
                                        distanceBackedEvidence &&
                                        movingEvidenceCount >= 3 &&
                                        now - movingEvidenceStartedAt >= stationaryExitFastEvidenceMinMs;

      if (fastDistanceBackedEvidence || (distanceBackedEvidence && sustainedEvidence)) {
        vehicle_state = "MOVING";
        hasStationaryReferenceAltitude = false;
        resetStationaryGpsAnchor("boot/search confirmed movement");
      } else {
        Serial.print("[GPS] Boot/search movement evidence ");
        Serial.print(movingEvidenceCount);
        Serial.print("/");
        Serial.print(stationaryExitMovingConfirmations);
        Serial.print(" elapsed=");
        Serial.print((now - movingEvidenceStartedAt) / 1000UL);
        Serial.print("s speed=");
        Serial.print(gps_speed);
        Serial.print(" distance=");
        Serial.println(distance_between);
      }
    } else if (vehicle_state == "STATIONARY" && speedOnlyMovement && goodFix) {
      movingEvidenceCount = 0;
      movingEvidenceStartedAt = 0;
      stationaryEvidenceCount++;
      Serial.print("[GPS] Ignoring boot/search stationary speed-only spike speed=");
      Serial.print(gps_speed);
      Serial.print(" distance=");
      Serial.print(distance_between);
      Serial.print(" threshold=");
      Serial.println(stationaryDistanceGate);
    } else if (movementDetected) {
      movingEvidenceCount++;
      movingEvidenceStartedAt = now;
      stationaryEvidenceCount = 0;
      vehicle_state = "MOVING";
    } else {
      // Only a GOOD fix that positively fails movement criteria is stationary
      // evidence. This branch is never reached for poor/invalid GPS.
      stationaryEvidenceCount++;
      movingEvidenceCount = 0;
      movingEvidenceStartedAt = 0;
      if (stationaryEvidenceCount >= 3) {
        vehicle_state = "STATIONARY";
      }
    }

    if (goodFix) {
      if (vehicle_state == "STATIONARY" && stationaryGpsAnchor.valid) {
        lastlat = stationaryGpsAnchor.lat;
        lastlon = stationaryGpsAnchor.lon;
        if (!hasStationaryReferenceAltitude || gps_speed == 0) {
          stationaryReferenceAltitude = gps_altitude;
          hasStationaryReferenceAltitude = true;
        }
      } else {
        lastlat = gps_lat;
        lastlon = gps_lon;
      }
    }
  }

  if (vehicle_state != lastReportedVehicleState) {
    Serial.print("[GPS] Vehicle state=");
    Serial.print(vehicle_state);
    Serial.print(" speed=");
    Serial.print(gps_speed);
    Serial.print(" distance=");
    Serial.print(distance_between);
    Serial.print(" threshold=");
    Serial.print(distanceThreshold);
    Serial.print(" sats=");
    Serial.print(gps_satellites);
    Serial.print(" hdop=");
    Serial.print(gps_hdop);
    if (filterStateKnown) {
      Serial.print(" authority=R16_FILTER stage=");
      Serial.print(R11Filter::stageName());
    }
    if (usingStationaryAnchor) {
      Serial.print(" anchorGate=");
      Serial.print(stationaryAnchorGate);
    }
    Serial.println();
    lastReportedVehicleState = vehicle_state;
  }
}

static String breadcrumbTimestamp(const TrackingBreadcrumb& point) {
  if (point.capturedEpoch != 0) {
    return dateStringFromEpoch(point.capturedEpoch);
  }
  if (isValidDateTime(gps_day, gps_month, gps_year) &&
      gps_hour >= 0 && gps_hour <= 23 && gps_minute >= 0 && gps_minute <= 59 &&
      gps_second >= 0 && gps_second <= 59) {
    uint32_t nowEpoch = utcEpochFromLocalDateTime(
        gps_day, gps_month, gps_year, gps_hour, gps_minute, gps_second, 0);
    uint32_t ageSeconds = (uint32_t)(millis() - point.capturedAtMs) / 1000UL;
    if (nowEpoch > ageSeconds) {
      return dateStringFromEpoch(nowEpoch - ageSeconds);
    }
  }
  return createNoGpsDate();
}

static JsonObject appendTrackingJsonRow(
    JsonDocument& doc,
    int satellites,
    int hdop,
    float lat,
    float lon,
    int age,
    const String& date,
    int altitude,
    float course,
    int speed,
    const String& state,
    bool locationTrustedForGeofence) {
  JsonObject obj = doc.add<JsonObject>();
  obj["satellites"] = satellites;
  obj["hdop"] = hdop;
  obj["lat"] = lat;
  obj["lon"] = lon;
  obj["age"] = age;
  obj["time_from"] = date;
  obj["time_to"] = date;
  obj["altitude"] = altitude;
  obj["course"] = course;
  obj["speed"] = state == "STATIONARY" ? 0 : speed;
  obj["fuel_adc"] = fuel_level;
  obj["ignition"] = ignition;
  obj["battery_percentage"] = battery_percentage;
  obj["vbatt"] = extBatteryVoltage * 10 / 10.0;
  obj["state"] = state;
  obj["geofence_violation_state"] = locationTrustedForGeofence
      ? vehicleGeofenceViolationState(lat, lon)
      : "NO_POLYGON";
  obj["geofence_id"] = geofenceId;

  // CAN & OBD-II Telemetry (Honda Fit GP1 Hybrid)
  populateTelemetryJsonRow(obj);

  return obj;
}

String generateJson() {
  Serial.println("GENERATE JSON");
  JsonDocument doc;

  updateVehicleStateFromGps();

  bool trustedGpsFix = hasTrustedGpsQuality();
  bool poorGpsFix = currentGpsFixIsPoorButUsable();
  bool staleOneShotGpsFix = currentGpsFixIsOneShotStaleLocation();
  bool lowConfidenceGpsFix = poorGpsFix || staleOneShotGpsFix;

  // R19 tertiary location source: use A7670 LBS only when the normal GNSS
  // pipeline has no trusted, poor-but-usable, or one-shot stale GPS fix.
  // LBS never enters R11 and never affects anchor/movement authority.
  float lbsLat = 0.0f;
  float lbsLon = 0.0f;
  float lbsAccuracyM = 0.0f;
  uint32_t lbsAgeMs = 0;
  bool lbsFallbackAvailable = !trustedGpsFix && !lowConfidenceGpsFix &&
      getLbsFallbackLocation(lbsLat, lbsLon, lbsAccuracyM, lbsAgeMs);

  // TI1R1 SINGLE-HISTORY MODEL:
  // Live telemetry contains exactly the current location row. Historical/outage
  // points use only /offlineData.csv and are replayed by its existing ACK-safe
  // uploader. Do not mix a second breadcrumb stream into this live payload.
  bool currentLocationAvailable = trustedGpsFix || lowConfidenceGpsFix || lbsFallbackAvailable;
  uint8_t batchCount = 0;
  static bool singleHistoryModeLogged = false;
  if (!singleHistoryModeLogged) {
    Serial.println("EVENT,TRACK_HISTORY_MODE,SINGLE_OFFLINE_QUEUE,LIVE_ONLY_PAYLOAD,1");
    singleHistoryModeLogged = true;
  }

  if (!trustedGpsFix) {
    if (poorGpsFix) {
      Serial.println("Poor-but-usable GPS fix; sending low-confidence coordinates");
    } else if (staleOneShotGpsFix) {
      Serial.println("One-shot stale GPS coordinate; sending last-known low-confidence coordinates");
    } else if (lbsFallbackAvailable && batchCount == 0) {
      Serial.print("No GNSS fix; sending A7670 LBS fallback coordinates accuracy_m=");
      Serial.println(lbsAccuracyM, 1);
    } else if (batchCount == 0) {
      Serial.println("No trusted GPS fix; sending invalid GPS row so non-location fields are recorded");
    } else {
      Serial.println("No current trusted GPS fix; sending retained moving breadcrumb batch without an invalid live row");
    }
  }

  String sendDate = trustedGpsFix
      ? createDate(gps_day, gps_month, gps_year, gps_hour, gps_minute, gps_second)
      : createNoGpsDate();

  if (lbsFallbackAvailable) {
    String lbsUtcDate;
    uint32_t lbsTimeAgeMs = 0;
    if (getLbsFallbackUtcDate(lbsUtcDate, lbsTimeAgeMs)) {
      // CLBS time is UTC/GMT, so use it directly on the same time basis as
      // GNSS. The helper advances the captured epoch with millis().
      sendDate = lbsUtcDate;
      Serial.print("EVENT,LBS_PAYLOAD_TIME_UTC,VALUE,");
      Serial.print(sendDate);
      Serial.print(",AGE_MS,");
      Serial.println(lbsTimeAgeMs);
    } else {
      Serial.println("EVENT,LBS_PAYLOAD_TIME_FALLBACK,REASON,LBS_TIME_UNAVAILABLE");
    }
  }

  if (sendDate.length() == 0) {
    Serial.println("GPS/LBS time unavailable; using safe old communication fallback timestamp");
    sendDate = "01/01/2026 00:00:00 GMT";
  }

  int reportedSatellites = reportedDualGnssSatelliteCount();
  int sendSatellites = reportedSatellites;
  int sendHdop = (int)round(gps_hdop);
  float sendLat = gps_lat;
  float sendLon = gps_lon;
  int sendAge = gps_age;
  int sendAltitude = gps_altitude;
  float sendCourse = gps_course;
  int sendSpeed = gps_speed;

  if (vehicle_state == "STATIONARY" || R11Filter::authoritativeVehicleStationary()) {
    sendSpeed = 0;
  }

  if (lowConfidenceGpsFix) {
    sendSatellites = encodePoorGpsSatelliteCount(reportedSatellites);
    if (vehicle_state != "MOVING") sendSpeed = 0;
  } else if (!trustedGpsFix) {
    sendSatellites = 0;
    sendHdop = 0;
    if (vehicle_state != "MOVING") sendSpeed = 0;
  }

  if (lbsFallbackAvailable) {
    // R19 LBS source marker: add 200 to the currently reported satellite
    // count so the existing platform payload can identify an LBS-derived
    // coordinate without changing the JSON schema. Examples: 200 = LBS
    // with zero satellites, 203 = LBS while three satellites are reported.
    sendSatellites = 200 + max(reportedSatellites, 0);
    sendHdop = 0;
    sendLat = lbsLat;
    sendLon = lbsLon;
    sendAge = (int)lbsAgeMs;
    sendAltitude = 0;
    sendCourse = -1.0f;
    sendSpeed = 0;
  }

  // TI1R1 LIVE PRIORITY: with no history mixed into this request, a valid live
  // location can never be displaced by backlog replay.
  bool appendCurrent = currentLocationAvailable;

  if (appendCurrent) {
    noteGnssDiagnosticPayload(
        sendLat, sendLon, sendSpeed, sendSatellites, sendHdop,
        lbsFallbackAvailable ? "LBS_A7670" : (trustedGpsFix ? "GNSS_TRUSTED" : (lowConfidenceGpsFix ? "GNSS_LOW_CONF" : "NO_GNSS")));
    appendTrackingJsonRow(
        doc,
        sendSatellites,
        sendHdop,
        sendLat,
        sendLon,
        sendAge,
        sendDate,
        sendAltitude,
        sendCourse,
        sendSpeed,
        vehicle_state,
        trustedGpsFix);
  }

  String jsonString;
  serializeJson(doc, jsonString);
  return jsonString;
}

void commands(){   // check if driver violates the speed limit
  Serial.println("COMMANDS");
    bool processedSpeedReliable = hasTrustedGpsQuality();
    float processedSpeedKmph = processedSpeedReliable ? gps_speed : 0;

    static uint8_t overspeedConsecutiveFixes = 0;
    if (processedSpeedReliable && processedSpeedKmph > SPEED_LIMIT) {
      if (++overspeedConsecutiveFixes >= OVERSPEED_SUSTAINED_FIXES && speedViolationState == NO_VIOLATION) {
        speedViolationState = VIOLATION_AWAITING_SENDING;
        speedViolationKmph = processedSpeedKmph;
      }
    } else if (processedSpeedReliable) {
      overspeedConsecutiveFixes = 0;
      if (speedViolationState == VIOLATION_SENT) {
        speedViolationState = NO_VIOLATION;
        speedViolationKmph = 0;
      }
    } else {
      Serial.println("[VIOLATION] Skipping speed-limit check; processed GPS speed is not reliable");
    }

    // check if the vehicle is in a geofence
    if (vehicleGeofenceViolationState(gps_lat, gps_lon) == "VIOLATION") {

    //Serial.println("Vechile is out of bounds");

      if (geofenceViolationState == NO_VIOLATION) {
        geofenceViolationState = VIOLATION_AWAITING_SENDING;
      }
    } else {

  //  Serial.println("Vechile is in bounds");

      if (geofenceViolationState == VIOLATION_SENT) {
        geofenceViolationState = NO_VIOLATION;
      }
    }
}

void initGNSS_XTRA_SUPL() {
  Serial.println("=== Initializing GNSS + A-GPS (XTRA + SUPL) ===");

  modem.restart();
  delay(5000);

  modem.sendAT("+CGATT=1");
  modem.waitResponse();

  modem.sendAT("+CGDCONT=1,\"IP\",\"internet\"");  // replace APN
  modem.waitResponse();

  modem.sendAT("+CGACT=1,1");
  modem.waitResponse(10000);

  // Configure SUPL server
  modem.sendAT("+CGPSSUPLURL=\"supl.google.com\",7275");
  modem.waitResponse();

  // Enable XTRA (offline A-GPS)
  modem.sendAT("+CGPSXTRA=1");
  modem.waitResponse();

  // Download latest XTRA data
  modem.sendAT("+CGPSXTRADOWNLOAD");
  modem.waitResponse(30000);

  // Start GNSS
  modem.sendAT("+CGPS=1,1");
  modem.waitResponse();

  // Enable NMEA output
  modem.sendAT("+CGPSOUT=32");
  modem.waitResponse();

  // Optional: use multiple constellations
  modem.sendAT("+CGNSSMODE=3");  // GPS + Beidou
  modem.waitResponse();

  Serial.println("GNSS + A-GPS + SUPL ready");
}
