// Cola store-and-forward persistente en LittleFS.
//
// Los registros (una línea JSON cada uno) se escriben en "segmentos":
// archivos /q/00000017.jl de hasta N registros. Cada segmento cerrado es
// exactamente un lote HTTP. Ventajas:
//   - Sobrevive a reinicios y cortes de batería (cada línea se escribe y cierra).
//   - Confirmar un lote = borrar un archivo (O(1), sin reescribir la flash).
//   - Si la memoria se llena, se descarta el segmento MÁS VIEJO y se cuenta.
#pragma once
#include <Arduino.h>

class SfQueue {
 public:
  bool begin(uint32_t maxSegments, uint16_t recordsPerSegment, size_t bytesPerSegment);

  // Añade un registro (JSON de una línea, sin '\n').
  bool push(const String& jsonLine);

  // Lote más antiguo como arreglo JSON "[{...},{...}]". No lo borra.
  // Si solo existe el segmento abierto, lo cierra primero.
  bool oldest(String& path, String& recordsJson, uint16_t& count);

  // El servidor confirmó el lote: se borra.
  void ack(const String& path, uint16_t count);

  // El servidor rechazó el lote como inválido (p. ej. línea corrupta tras un
  // corte de energía): se descarta para no bloquear la cola para siempre.
  void discard(const String& path, uint16_t count);

  uint32_t depth() const { return depth_; }
  uint32_t dropped() const { return dropped_; }

 private:
  String segPath(uint32_t idx) const;
  uint16_t countLines(const String& path) const;
  void rotate();
  void enforceCapacity();
  void saveDropped();

  uint32_t maxSegments_ = 0;
  uint16_t recordsPerSegment_ = 0;
  size_t bytesPerSegment_ = 0;

  uint32_t first_ = 0;      // segmento más antiguo
  uint32_t head_ = 0;       // segmento abierto (escritura)
  uint16_t headCount_ = 0;
  size_t headBytes_ = 0;
  uint32_t depth_ = 0;
  uint32_t dropped_ = 0;
};
