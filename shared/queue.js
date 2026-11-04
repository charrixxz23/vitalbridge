// Cola store-and-forward. Es la misma lógica que corre en el firmware
// (firmware/src/sf_queue.*), escrita en JS para poder probarla y simularla.
//
// Política ante memoria llena: se descarta lo MÁS VIEJO y se cuenta.
// En un maletín es preferible perder el minuto 1 de hace tres horas que el
// signo vital de hace 10 segundos. El contador de descartados viaja al
// servidor para que la pérdida nunca sea silenciosa.

export class StoreAndForwardQueue {
  constructor({ capacity = 5000, bootId }) {
    this.capacity = capacity;
    this.bootId = bootId;
    this.items = [];
    this.nextSeq = 0;
    this.dropped = 0;
  }

  /** Encola un registro y le asigna número de secuencia monotónico. */
  push(record) {
    const item = { ...record, seq: this.nextSeq++, boot: this.bootId };
    this.items.push(item);
    while (this.items.length > this.capacity) {
      this.items.shift();
      this.dropped += 1;
    }
    return item;
  }

  get depth() {
    return this.items.length;
  }

  /** Lote más antiguo SIN sacarlo: solo se borra cuando el servidor confirma. */
  peekBatch(max = 100) {
    return this.items.slice(0, max);
  }

  /** El servidor respondió 200: se eliminan los registros del lote. */
  ack(batch) {
    if (batch.length === 0) return;
    const lastSeq = batch[batch.length - 1].seq;
    const lastBoot = batch[batch.length - 1].boot;
    const idx = this.items.findIndex((r) => r.boot === lastBoot && r.seq === lastSeq);
    // Si el lote ya no está al frente (se descartó por capacidad), se ignora.
    if (idx >= 0) this.items.splice(0, idx + 1);
  }
}
