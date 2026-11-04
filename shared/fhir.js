// Exportación HL7 FHIR R4: convierte las lecturas a Observations del perfil
// "vital signs" con códigos LOINC, para que cualquier expediente clínico
// electrónico que hable FHIR pueda importarlas sin adaptadores a medida.

const VITALS = [
  { field: 'hr', loinc: '8867-4', display: 'Heart rate', unit: '/min', ucum: '/min' },
  { field: 'spo2', loinc: '59408-5', display: 'Oxygen saturation in Arterial blood by Pulse oximetry', unit: '%', ucum: '%' },
  { field: 'temp', loinc: '8310-5', display: 'Body temperature', unit: 'Cel', ucum: 'Cel' },
];

export function toFhirBundle({ device, rows, baseUrl }) {
  const entries = [];
  for (const row of rows) {
    for (const v of VITALS) {
      const value = row[v.field];
      if (value === null || value === undefined) continue;
      const id = `${device.id}-${row.ts}-${v.field}`;
      entries.push({
        fullUrl: `${baseUrl}/fhir/Observation/${id}`,
        resource: {
          resourceType: 'Observation',
          id,
          status: 'final',
          category: [{
            coding: [{
              system: 'http://terminology.hl7.org/CodeSystem/observation-category',
              code: 'vital-signs',
              display: 'Vital Signs',
            }],
          }],
          code: { coding: [{ system: 'http://loinc.org', code: v.loinc, display: v.display }] },
          subject: device.patient_id ? { reference: `Patient/${device.patient_id}` } : undefined,
          device: { reference: `Device/${device.id}` },
          effectiveDateTime: new Date(row.ts).toISOString(),
          issued: new Date(row.received_at).toISOString(),
          valueQuantity: { value, unit: v.unit, system: 'http://unitsofmeasure.org', code: v.ucum },
          // Si la hora es solo la de llegada (sin NTP), se deja constancia.
          ...(row.ts_quality === 'arrival'
            ? { note: [{ text: 'Hora de medición desconocida; se usa la hora de recepción.' }] }
            : {}),
        },
      });
    }
  }
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    timestamp: new Date().toISOString(),
    total: entries.length,
    entry: entries,
  };
}
