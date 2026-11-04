#pragma once

// Credenciales: se usan las de secrets.h si existe (no se sube a GitHub).
#if __has_include("secrets.h")
#include "secrets.h"
#else
#warning "Sin include/secrets.h: usando valores de ejemplo (no se conectará a ninguna red)."
#define WIFI_SSID     ""
#define WIFI_PASS     ""
#define SERVER_URL    "http://192.168.1.50:8080/api/v1/ingest"
#define INGEST_TOKEN  "demo-token"
#define DEVICE_ID     "maletin-esp32-01"
#define PATIENT_ID    "P-0001"
#endif

#define FW_VERSION    "0.1.0"

// ── Pines (ESP32 DevKit v1) ───────────────────────────────────────────────
// AD8232: OUTPUT a un pin del ADC1 (el ADC2 no funciona con Wi-Fi activo).
#define PIN_ECG_OUT   34
#define PIN_ECG_LO_P  32
#define PIN_ECG_LO_N  33
// MAX30102 por I2C
#define PIN_I2C_SDA   21
#define PIN_I2C_SCL   22
#define PIN_LED       2

// ── ECG ───────────────────────────────────────────────────────────────────
#define ECG_ADC_HZ        250   // muestreo real
#define ECG_OUT_HZ        125   // tras promediar pares (antialias + mitad de datos)
#define ECG_LIVE_SECONDS  2     // con red: tiras de 2 s continuas
#define ECG_STRIP_SECONDS 10    // sin red: una tira de 10 s...
#define ECG_STRIP_EVERY_S 30    // ...cada 30 s (no cabe el ECG continuo en flash)

// ── Cola store-and-forward en LittleFS ────────────────────────────────────
#define Q_RECORDS_PER_SEGMENT 40
#define Q_BYTES_PER_SEGMENT   24000
#define Q_MAX_SEGMENTS        110    // ~10 KB c/u sin red ≈ 1.1 MB ≈ 1 h de autonomía (LittleFS ~1.4 MB)

// ── Red ───────────────────────────────────────────────────────────────────
#define NTP_SERVER        "pool.ntp.org"
#define TZ_OFFSET_S       (-5 * 3600)   // Panamá, UTC−5, sin horario de verano
#define HTTP_TIMEOUT_MS   5000
#define SEND_MAX_PER_LOOP 4             // lotes por vuelta para ponerse al día rápido
