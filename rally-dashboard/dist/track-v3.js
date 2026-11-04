// Geometría de la pista v3 y paleta de terrenos. Se comparte entre el mapa 2D y la vista 3D.
// Solo presentación: las reglas y las posiciones vienen siempre de Python.

export const TERRAIN_COLORS = {
  asfalto: '#d98a58',
  lodo: '#5a3b24',
  agua: '#2f86d6',
  sin_pista: '#9fbf2e',
  foso: '#17110e',
  barril: '#d98a58',
  rampa: '#b9622f',
  rampa_con_barril: '#b9622f',
  puente: '#f2b48b',
  puente_roto: '#17110e',
};

export const LANE_ACCENTS = ['#8a5a36', '#2f86d6', '#9fbf2e', '#e8553d'];

export function makeTrack({ straight = 120, radius = 30, laneWidth = 4.4, lanes = 4, startOffset = 14 } = {}) {
  const S = straight, R = radius, W = laneWidth;
  const perimeter = 2 * S + 2 * Math.PI * R;

  // Centro del óvalo recorrido a la vuelta: recta inferior (+x), curva derecha, recta superior (-x), curva izquierda.
  function centerAt(a) {
    a = ((a % perimeter) + perimeter) % perimeter;
    if (a < S) return { x: -S / 2 + a, z: R, dx: 1, dz: 0 };
    a -= S;
    if (a < Math.PI * R) {
      const th = Math.PI / 2 - a / R;
      return { x: S / 2 + R * Math.cos(th), z: R * Math.sin(th), dx: Math.sin(th), dz: -Math.cos(th) };
    }
    a -= Math.PI * R;
    if (a < S) return { x: S / 2 - a, z: -R, dx: -1, dz: 0 };
    a -= S;
    const th = -Math.PI / 2 - a / R;
    return { x: -S / 2 + R * Math.cos(th), z: R * Math.sin(th), dx: Math.sin(th), dz: -Math.cos(th) };
  }

  // u = vuelta completa 0..1. offset > 0 = hacia el interior del óvalo.
  function pointAt(u, offset = 0) {
    const c = centerAt(u * perimeter + startOffset);
    const nx = c.dz, nz = -c.dx;
    return { x: c.x + nx * offset, z: c.z + nz * offset, dx: c.dx, dz: c.dz, nx, nz };
  }

  // Carril 0 = el más interior (izquierda al mirar hacia adelante), carril 3 = el más exterior.
  const laneOffset = lane => (lanes / 2 - 0.5 - lane) * W;

  return { S, R, W, lanes, perimeter, centerAt, pointAt, laneOffset };
}
