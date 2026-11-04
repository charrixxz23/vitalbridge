#include "sf_queue.h"
#include <LittleFS.h>

static const char* DIR = "/q";
static const char* DROPPED_FILE = "/qdropped";

String SfQueue::segPath(uint32_t idx) const {
  char buf[24];
  snprintf(buf, sizeof(buf), "%s/%08lu.jl", DIR, (unsigned long)idx);
  return String(buf);
}

uint16_t SfQueue::countLines(const String& path) const {
  File f = LittleFS.open(path, FILE_READ);
  if (!f) return 0;
  uint16_t n = 0;
  while (f.available()) if (f.read() == '\n') n++;
  f.close();
  return n;
}

bool SfQueue::begin(uint32_t maxSegments, uint16_t recordsPerSegment, size_t bytesPerSegment) {
  maxSegments_ = maxSegments;
  recordsPerSegment_ = recordsPerSegment;
  bytesPerSegment_ = bytesPerSegment;

  if (!LittleFS.begin(true)) return false;  // true = formatear si está dañado
  if (!LittleFS.exists(DIR)) LittleFS.mkdir(DIR);

  // Reconstruir el estado escaneando los segmentos que quedaron de antes.
  bool any = false;
  uint32_t lo = UINT32_MAX, hi = 0;
  File dir = LittleFS.open(DIR);
  for (File f = dir.openNextFile(); f; f = dir.openNextFile()) {
    String name = f.name();                 // "00000017.jl" (sin ruta en LittleFS)
    int slash = name.lastIndexOf('/');
    if (slash >= 0) name = name.substring(slash + 1);
    uint32_t idx = strtoul(name.c_str(), nullptr, 10);
    f.close();
    any = true;
    lo = min(lo, idx);
    hi = max(hi, idx);
  }
  dir.close();

  if (any) {
    first_ = lo;
    head_ = hi + 1;  // nunca seguir escribiendo en un segmento de un arranque anterior
    for (uint32_t i = first_; i <= hi; i++) {
      String p = segPath(i);
      if (LittleFS.exists(p)) depth_ += countLines(p);
    }
  }

  File d = LittleFS.open(DROPPED_FILE, FILE_READ);
  if (d) { dropped_ = d.readString().toInt(); d.close(); }
  return true;
}

bool SfQueue::push(const String& jsonLine) {
  if (headCount_ >= recordsPerSegment_ || headBytes_ + jsonLine.length() + 1 > bytesPerSegment_) rotate();
  File f = LittleFS.open(segPath(head_), FILE_APPEND);
  if (!f) return false;
  size_t w = f.print(jsonLine);
  w += f.print('\n');
  f.close();
  if (w != jsonLine.length() + 1) return false;  // flash llena
  headCount_++;
  headBytes_ += w;
  depth_++;
  return true;
}

void SfQueue::rotate() {
  if (headCount_ == 0) return;
  head_++;
  headCount_ = 0;
  headBytes_ = 0;
  enforceCapacity();
}

void SfQueue::enforceCapacity() {
  while (head_ - first_ > maxSegments_) {
    String p = segPath(first_);
    if (LittleFS.exists(p)) {
      uint16_t n = countLines(p);
      LittleFS.remove(p);
      depth_ -= min<uint32_t>(depth_, n);
      dropped_ += n;
      saveDropped();
    }
    first_++;
  }
}

bool SfQueue::oldest(String& path, String& recordsJson, uint16_t& count) {
  if (depth_ == 0) return false;
  // Saltar índices vacíos (p. ej. segmentos que nunca llegaron a crearse).
  while (first_ < head_ && !LittleFS.exists(segPath(first_))) first_++;
  if (first_ == head_) rotate();  // solo hay datos en el segmento abierto: cerrarlo
  if (first_ == head_) return false;

  path = segPath(first_);
  File f = LittleFS.open(path, FILE_READ);
  if (!f) return false;

  recordsJson = "[";
  count = 0;
  while (f.available()) {
    String line = f.readStringUntil('\n');
    line.trim();
    // Una línea truncada por corte de energía no se envía.
    if (line.length() < 2 || line[0] != '{' || line[line.length() - 1] != '}') continue;
    if (count++) recordsJson += ',';
    recordsJson += line;
  }
  f.close();
  recordsJson += "]";

  if (count == 0) {  // segmento vacío o totalmente corrupto
    discard(path, countLines(path));
    return oldest(path, recordsJson, count);
  }
  return true;
}

void SfQueue::ack(const String& path, uint16_t count) {
  uint16_t lines = countLines(path);
  LittleFS.remove(path);
  depth_ -= min<uint32_t>(depth_, max(count, lines));
  if (first_ < head_) first_++;
}

void SfQueue::discard(const String& path, uint16_t count) {
  dropped_ += count;
  saveDropped();
  ack(path, count);
}

void SfQueue::saveDropped() {
  File d = LittleFS.open(DROPPED_FILE, FILE_WRITE);
  if (d) { d.print(dropped_); d.close(); }
}
