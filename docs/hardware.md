# Hardware

## Lista de materiales

| Componente | Función | Precio aprox. (USD) |
|---|---|---|
| ESP32 DevKit v1 (ESP32-WROOM-32) | Microcontrolador con Wi-Fi y 4 MB de flash | 6–10 |
| Módulo AD8232 + cable de 3 derivaciones + electrodos | Frente analógico de ECG | 8–15 |
| Módulo MAX30102 | Oximetría de pulso (SpO₂ y FC) | 3–6 |
| Power bank USB o batería LiPo + cargador TP4056 | Alimentación aislada | 5–15 |
| Protoboard y cables dupont | Montaje | 3–5 |

Total: aproximadamente **25–50 USD**. Los precios varían según el proveedor.

## Conexiones

| Módulo | Pin del módulo | ESP32 |
|---|---|---|
| AD8232 | 3.3V | 3V3 |
| AD8232 | GND | GND |
| AD8232 | OUTPUT | GPIO 34 (ADC1) |
| AD8232 | LO+ | GPIO 32 |
| AD8232 | LO− | GPIO 33 |
| MAX30102 | VIN | 3V3 |
| MAX30102 | GND | GND |
| MAX30102 | SDA | GPIO 21 |
| MAX30102 | SCL | GPIO 22 |

La salida del ECG va al **ADC1** a propósito: el ADC2 del ESP32 no se puede
leer mientras el Wi-Fi está encendido.

Electrodos (derivación I): **RA** (rojo) bajo la clavícula derecha, **LA**
(amarillo) bajo la clavícula izquierda y **RL** (verde) en la parte baja del
abdomen, lado derecho.

## Seguridad eléctrica

> **Importante.** Con electrodos puestos en una persona, alimenta el equipo
> **solo con batería o power bank**. No lo conectes al mismo tiempo a una
> laptop enchufada a la red eléctrica ni a un cargador de pared: sin
> aislamiento galvánico, una falla del cargador puede llegar al cuerpo.
> Para ver el log por USB, quita antes los electrodos.

Este es un prototipo académico. No cumple IEC 60601-1 ni ninguna otra norma de
equipos electromédicos y no debe usarse para diagnosticar ni tratar a nadie.

## Configurar y grabar

1. Instala [PlatformIO](https://platformio.org/install) (CLI o extensión de VS Code).
2. Copia `firmware/include/secrets.example.h` a `firmware/include/secrets.h`.
3. Rellena el Wi-Fi, la URL del servidor y el token. Al ejecutar `npm start`,
   el servidor imprime la URL exacta para el ESP32.
4. Graba y abre el monitor serie:

   ```bash
   cd firmware
   pio run -t upload
   pio device monitor
   ```

## Probar el store-and-forward con hardware

1. Con el dashboard abierto, apaga el router o el hotspot del teléfono.
   El LED del ESP32 empieza a parpadear y el dashboard muestra *Sin señal*.
2. Espera uno o dos minutos. Puedes reiniciar el ESP32: la cola está en flash.
3. Vuelve a encender la red. El log muestra los lotes enviados y el dashboard
   rellena la tendencia con franjas moradas (*recuperado de la cola*).

## Uso de memoria

La cola usa la partición LittleFS (~1.4 MB con `default.csv`):

| Modo | Datos | Consumo aprox. |
|---|---|---|
| Con red | Signos vitales cada 1 s + ECG continuo (tiras de 2 s) | Se envía y se borra |
| Sin red | Signos vitales cada 1 s + tira de ECG de 10 s cada 30 s | ~0.3 KB/s |

Con los valores por defecto (`Q_MAX_SEGMENTS = 110`, unos 10 KB por segmento
sin red), el equipo aguanta alrededor de **una hora** sin señal antes de
empezar a descartar los datos más viejos. Esos descartes se cuentan y se reportan al servidor.
