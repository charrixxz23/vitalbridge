// VitalBridge — gateway store-and-forward para maletín de telemedicina.
//
//  ┌──────────┐  ADC 250 Hz   ┌───────────────┐   LittleFS   ┌───────────┐  HTTP/JSON
//  │ AD8232   ├──────────────►│               ├─────────────►│ cola de   ├────────────► servidor
//  │ (ECG)    │               │  ESP32        │   1 línea    │ segmentos │  cuando hay
//  ├──────────┤  I2C 25 Hz    │  - FC / SpO₂  │  por registro│ (lotes)   │  señal
//  │ MAX30102 ├──────────────►│  - lotes      │              └───────────┘
//  └──────────┘               └───────────────┘
//
// Prototipo académico: NO es un dispositivo médico.
#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <sys/time.h>
#include "MAX30105.h"
#include "spo2_algorithm.h"

#include "config.h"
#include "sf_queue.h"

static SfQueue queue;
static SemaphoreHandle_t qLock;  // la cola la usan loop() (escribe) y netTask (lee/borra)
struct QGuard {
  QGuard() { xSemaphoreTake(qLock, portMAX_DELAY); }
  ~QGuard() { xSemaphoreGive(qLock); }
};
static MAX30105 oximeter;
static bool oximeterOk = false;
static char bootId[9];
static uint32_t seq = 0;

// ════════════════════════════════════════════════════════════════════════
// ECG: tarea dedicada en el núcleo 1, muestreo determinista a 250 Hz
// ════════════════════════════════════════════════════════════════════════
static const int ECG_RING = ECG_OUT_HZ * ECG_STRIP_SECONDS;  // últimos 10 s
static uint16_t ecgRing[ECG_RING];
static volatile uint32_t ecgTotal = 0;     // muestras (125 Hz) producidas desde el arranque
static volatile bool ecgLeadOff = false;
static portMUX_TYPE ecgMux = portMUX_INITIALIZER_UNLOCKED;

static void ecgTask(void*) {
  const TickType_t period = pdMS_TO_TICKS(1000 / ECG_ADC_HZ);  // 4 ms
  TickType_t last = xTaskGetTickCount();
  uint32_t acc = 0;
  uint8_t n = 0;
  for (;;) {
    vTaskDelayUntil(&last, period);
    bool lo = digitalRead(PIN_ECG_LO_P) || digitalRead(PIN_ECG_LO_N);
    acc += lo ? 2048 : analogRead(PIN_ECG_OUT);
    if (++n == ECG_ADC_HZ / ECG_OUT_HZ) {     // promedio de 2 → 125 Hz
      uint16_t s = acc / n;
      acc = 0; n = 0;
      portENTER_CRITICAL(&ecgMux);
      ecgRing[ecgTotal % ECG_RING] = s;
      ecgTotal = ecgTotal + 1;
      ecgLeadOff = lo;
      portEXIT_CRITICAL(&ecgMux);
    }
  }
}

// Copia las últimas `count` muestras como "[a,b,c]".
static String ecgSnapshot(int count, bool& leadOff) {
  static uint16_t tmp[ECG_RING];
  uint32_t end;
  portENTER_CRITICAL(&ecgMux);
  end = ecgTotal;
  leadOff = ecgLeadOff;
  if ((uint32_t)count > end) count = end;
  for (int i = 0; i < count; i++) tmp[i] = ecgRing[(end - count + i) % ECG_RING];
  portEXIT_CRITICAL(&ecgMux);

  String out;
  out.reserve(count * 5 + 2);
  out += '[';
  for (int i = 0; i < count; i++) {
    if (i) out += ',';
    out += tmp[i];
  }
  out += ']';
  return out;
}

// ════════════════════════════════════════════════════════════════════════
// Oximetría: algoritmo de Maxim sobre ventana de 4 s, actualizada cada 1 s
// ════════════════════════════════════════════════════════════════════════
static const int OX_N = 100;  // 4 s a 25 muestras/s
static uint32_t irBuf[OX_N], redBuf[OX_N];
static int oxFill = 0, oxNew = 0;
static int32_t lastHr = -1, lastSpo2 = -1;
static float hrAvg = 0, spo2Avg = 0;

static void pollOximeter() {
  if (!oximeterOk) return;
  oximeter.check();
  while (oximeter.available()) {
    if (oxFill < OX_N) {
      redBuf[oxFill] = oximeter.getFIFORed();
      irBuf[oxFill] = oximeter.getFIFOIR();
      oxFill++;
    } else {
      memmove(redBuf, redBuf + 1, (OX_N - 1) * sizeof(uint32_t));
      memmove(irBuf, irBuf + 1, (OX_N - 1) * sizeof(uint32_t));
      redBuf[OX_N - 1] = oximeter.getFIFORed();
      irBuf[OX_N - 1] = oximeter.getFIFOIR();
    }
    oxNew++;
    oximeter.nextSample();
  }

  if (oxFill < OX_N || oxNew < 25) return;
  oxNew = 0;

  // Sin dedo en el sensor la señal IR es muy baja: no inventar valores.
  if (irBuf[OX_N - 1] < 50000) { lastHr = lastSpo2 = -1; hrAvg = spo2Avg = 0; return; }

  int32_t spo2, hr;
  int8_t spo2Valid, hrValid;
  maxim_heart_rate_and_oxygen_saturation(irBuf, OX_N, redBuf, &spo2, &spo2Valid, &hr, &hrValid);
  // Suavizado exponencial: el algoritmo de referencia es ruidoso latido a latido.
  if (hrValid && hr > 20 && hr < 250) { hrAvg = hrAvg ? 0.7f * hrAvg + 0.3f * hr : hr; lastHr = lroundf(hrAvg); }
  if (spo2Valid && spo2 >= 50 && spo2 <= 100) { spo2Avg = spo2Avg ? 0.7f * spo2Avg + 0.3f * spo2 : spo2; lastSpo2 = lroundf(spo2Avg); }
}

// ════════════════════════════════════════════════════════════════════════
// Registros
// ════════════════════════════════════════════════════════════════════════
static bool clockValid() { return time(nullptr) > 1577836800; }  // > 2020-01-01

// Prefijo común: secuencia, arranque y tiempo (relativo y, si hay NTP, absoluto).
static String recordHeader(const char* kind) {
  char buf[128];
  int n = snprintf(buf, sizeof(buf), "{\"seq\":%lu,\"boot\":\"%s\",\"t\":%lu,",
                   (unsigned long)seq++, bootId, (unsigned long)millis());
  if (clockValid()) {
    struct timeval tv;
    gettimeofday(&tv, nullptr);
    uint64_t ms = (uint64_t)tv.tv_sec * 1000ULL + tv.tv_usec / 1000;
    n += snprintf(buf + n, sizeof(buf) - n, "\"epoch\":%llu,", (unsigned long long)ms);
  }
  snprintf(buf + n, sizeof(buf) - n, "\"kind\":\"%s\"", kind);
  return String(buf);
}

static void pushVitals() {
  bool leadOff;
  portENTER_CRITICAL(&ecgMux);
  leadOff = ecgLeadOff;
  portEXIT_CRITICAL(&ecgMux);

  String r = recordHeader("vitals");
  if (lastHr > 0) { r += ",\"hr\":"; r += lastHr; }
  if (lastSpo2 > 0) { r += ",\"spo2\":"; r += lastSpo2; }
  r += ",\"lead_off\":";
  r += leadOff ? 1 : 0;
  r += '}';
  QGuard g;
  queue.push(r);
}

static void pushEcg(int seconds) {
  bool leadOff;
  String samples = ecgSnapshot(seconds * ECG_OUT_HZ, leadOff);
  String r = recordHeader("ecg");
  r += ",\"fs\":" + String(ECG_OUT_HZ) + ",\"lead_off\":" + String(leadOff ? 1 : 0) + ",\"samples\":" + samples + '}';
  QGuard g;
  queue.push(r);
}

// ════════════════════════════════════════════════════════════════════════
// Red
// ════════════════════════════════════════════════════════════════════════
static bool online() { return WiFi.status() == WL_CONNECTED; }

static void sendPending() {
  for (int i = 0; i < SEND_MAX_PER_LOOP && online(); i++) {
    String path, records;
    uint16_t count;
    uint32_t depth, dropped;
    {
      QGuard g;
      if (!queue.oldest(path, records, count)) return;
      depth = queue.depth();
      dropped = queue.dropped();
    }

    String body;
    body.reserve(records.length() + 256);
    body += "{\"device_id\":\"" DEVICE_ID "\",\"patient_id\":\"" PATIENT_ID "\",\"boot_id\":\"";
    body += bootId;
    body += "\",\"firmware\":\"" FW_VERSION "\",\"uptime_ms\":";
    body += millis();
    body += ",\"queue_depth\":";
    body += depth - count;
    body += ",\"dropped\":";
    body += dropped;
    body += ",\"records\":";
    body += records;
    body += '}';

    HTTPClient http;
    http.setTimeout(HTTP_TIMEOUT_MS);
    http.begin(SERVER_URL);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Authorization", "Bearer " INGEST_TOKEN);
    int code = http.POST(body);
    http.end();

    if (code == 200) {
      QGuard g;
      queue.ack(path, count);
      Serial.printf("[net] lote de %u enviado, cola=%lu\n", count, (unsigned long)queue.depth());
    } else if (code == 400 || code == 413) {
      // Lote que el servidor nunca aceptará: descartarlo (contado) para no atascar la cola.
      QGuard g;
      queue.discard(path, count);
      Serial.printf("[net] lote rechazado (%d) y descartado\n", code);
    } else {
      // 401, 5xx o sin respuesta: se queda en la cola y se reintenta luego.
      Serial.printf("[net] envío falló (%d), reintento luego\n", code);
      return;
    }
  }
}

// Tarea de red en el núcleo 0: un POST lento (hasta 5 s) no debe frenar la
// lectura del oxímetro, cuyo FIFO se desborda en ~1.3 s.
static void netTask(void*) {
  for (;;) {
    if (online()) sendPending();
    vTaskDelay(pdMS_TO_TICKS(500));
  }
}

static void maintainWifi() {
  static uint32_t lastTry = 0;
  static bool wasOnline = false;
  bool now = online();
  if (now && !wasOnline) {
    Serial.printf("[net] conectado %s, cola=%lu\n", WiFi.localIP().toString().c_str(), (unsigned long)queue.depth());
    configTime(TZ_OFFSET_S, 0, NTP_SERVER);
  }
  if (!now && wasOnline) Serial.println("[net] sin señal: guardando en flash");
  if (!now && millis() - lastTry > 10000 && strlen(WIFI_SSID)) {
    lastTry = millis();
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASS);
  }
  wasOnline = now;
}

// ════════════════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_ECG_LO_P, INPUT);
  pinMode(PIN_ECG_LO_N, INPUT);
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_ECG_OUT, ADC_11db);  // rango ~0–3.3 V

  qLock = xSemaphoreCreateMutex();
  snprintf(bootId, sizeof(bootId), "%08lx", (unsigned long)esp_random());
  Serial.printf("\nVitalBridge %s · equipo %s · arranque %s\n", FW_VERSION, DEVICE_ID, bootId);

  if (!queue.begin(Q_MAX_SEGMENTS, Q_RECORDS_PER_SEGMENT, Q_BYTES_PER_SEGMENT)) {
    Serial.println("[q] ERROR: no se pudo montar LittleFS");
  } else {
    Serial.printf("[q] %lu registros pendientes de arranques anteriores\n", (unsigned long)queue.depth());
  }

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  oximeterOk = oximeter.begin(Wire, I2C_SPEED_FAST);
  if (oximeterOk) {
    // brillo, promedio, modo (rojo+IR), Hz, ancho de pulso, rango ADC
    oximeter.setup(60, 4, 2, 100, 411, 4096);
  } else {
    Serial.println("[ox] MAX30102 no encontrado; se enviará solo ECG");
  }

  xTaskCreatePinnedToCore(ecgTask, "ecg", 4096, nullptr, 3, nullptr, 1);
  xTaskCreatePinnedToCore(netTask, "net", 12288, nullptr, 1, nullptr, 0);

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  if (strlen(WIFI_SSID)) WiFi.begin(WIFI_SSID, WIFI_PASS);
}

void loop() {
  static uint32_t lastVitals = 0, lastStrip = 0, liveMark = 0;
  uint32_t now = millis();

  pollOximeter();
  maintainWifi();
  bool up = online();

  if (now - lastVitals >= 1000) {
    lastVitals = now;
    pushVitals();
  }

  if (up) {
    // Con red: ECG continuo en tiras de 2 s.
    uint32_t total;
    portENTER_CRITICAL(&ecgMux);
    total = ecgTotal;
    portEXIT_CRITICAL(&ecgMux);
    if (total - liveMark >= (uint32_t)ECG_OUT_HZ * ECG_LIVE_SECONDS) {
      liveMark = total;
      pushEcg(ECG_LIVE_SECONDS);
    }
  } else if (now - lastStrip >= ECG_STRIP_EVERY_S * 1000UL) {
    // Sin red: una tira de 10 s cada 30 s.
    lastStrip = now;
    pushEcg(ECG_STRIP_SECONDS);
    portENTER_CRITICAL(&ecgMux);
    liveMark = ecgTotal;
    portEXIT_CRITICAL(&ecgMux);
  }

  // LED: fijo = en línea; parpadeo = guardando sin red.
  digitalWrite(PIN_LED, up ? HIGH : ((now / 250) % 2));
  delay(5);
}
