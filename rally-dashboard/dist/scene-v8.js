import * as THREE from 'three';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { GLTFLoader } from './vendor/three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from './vendor/three/addons/libs/meshopt_decoder.module.js';
import { DecalGeometry } from './vendor/three/addons/geometries/DecalGeometry.js';
import { buildVenue } from './venue.js';
import { buildInfield } from './infield.js';
import { mergeGeometries } from './vendor/three/addons/utils/BufferGeometryUtils.js';

// Vista 3D del N8 (misma pista y mismos datos que el N7; más fluida y con el centro del óvalo lleno).
// Rendimiento: (1) las ~1.500 piezas fijas de la pista se unen en una docena de objetos, (2) el público se
// dibuja por sectores, (3) la resolución baja sola si el computador no llega a ~45 cuadros por segundo.
// Vista 3D del N7. Solo dibuja: la forma de la pista, los obstáculos de cada pista y las poses del
// coche vienen de Python (pipeline_v7.py). Nuevo: "Ver lo que ve la IA" dibuja los 8 puntos de la
// pista que recibe la red (0,5–5 s adelante a la velocidad del coche, igual que race_env_v7.py). Cada pose = [x, y, altura, rumbo de la carrocería,
// ángulo del volante, deslizamiento, cabeceo, balanceo, compresión de la suspensión]. Las ruedas
// quedan en el suelo y la CARROCERÍA se inclina sobre ellas: trompa abajo al frenar, hacia afuera
// en las curvas y se hunde al aterrizar.
// Conversión de coordenadas: Python (x, y, altura) -> Three.js (x, altura, -y).
const host = document.getElementById('scene3d');
const world = host.parentElement;
const message = document.getElementById('sceneStatus');
const tools = document.querySelector('.view-tools');
const data = window.rallyV8Data;
const cfg = data.config;
const LANES = cfg.track.lanes, W = cfg.track.lane_width_m, CELL = cfg.track.cell_m, HALF = LANES * W / 2;
const L = data.track_length, S = cfg.track.straight_m, R = cfg.track.radius_m;
const P = cfg.physics;
// Coche del N6: "Car Concept" de Khronos (Eric Chadwick / Darmstadt Graphics Group, CC BY 4.0, ver
// models3d/CREDITOS.md) con decoración de rally pintada en el navegador. Si no carga, se usa el coche del N4.
// wheelGroup: nombre de cada grupo de rueda (llanta + rin + disco); el frente y el radio se calculan solos.
const CAR = { url: 'models3d/coche-concepto.glb', length: 4.3, wheelGroup: /^Wheel(Front|Rear)[LR]$/, livery: true };
const CAR_OLD = { url: 'models3d/coche.glb', yaw: 0, length: 4.4, wheelRadius: 0.34, wheel: /Wheel/, wheelGroup: null, livery: false };
const RAMP_LEN = P.ramp_height_m / Math.tan(P.ramp_angle_deg * Math.PI / 180);
const samples = data.track_samples;           // [x, y, rumbo] cada 2 m
const STEP = 2;
const inCurve = s => { s = ((s % L) + L) % L; return (s >= S && s < S + Math.PI * R) || s >= 2 * S + Math.PI * R; };

function center(s) {
  s = ((s % L) + L) % L;
  const i = Math.floor(s / STEP), f = s / STEP - i;
  const a = samples[i % samples.length], b = samples[(i + 1) % samples.length];
  let dh = b[2] - a[2]; if (dh > Math.PI) dh -= 2 * Math.PI; if (dh < -Math.PI) dh += 2 * Math.PI;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + dh * f];
}
function at(s, d, h = 0) {           // punto (s, d) de la pista -> Vector3 de Three
  const [x, y, hd] = center(s);
  return new THREE.Vector3(x - d * Math.sin(hd), h, -(y + d * Math.cos(hd)));
}
// Rumbo de Python -> rotación de un modelo que mira a +z. Python (cos h, sin h) es Three (cos h, 0, -sin h),
// y girar +z en θ da (sin θ, 0, cos θ): θ = h + 90°. (En el N4 se usaba 90° − h: en las curvas el coche
// se veía girado; se corrigió aquí.)
const yawOf = heading => heading + Math.PI / 2;
const laneD = lane => ((LANES - 1) / 2 - lane) * W;

// ---------- texturas hechas en el navegador (sin descargar imágenes) ----------
function canvasTexture(size, paint, repeat = true) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'); paint(g, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}
function rand(seed) { let x = seed; return () => (x = (x * 16807) % 2147483647) / 2147483647; }
function noise(g, n, base, spread, rnd, alpha = 1) {
  const img = g.getImageData(0, 0, n, n), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const k = (rnd() - 0.5) * spread;
    d[i] = Math.max(0, Math.min(255, base[0] + k)); d[i + 1] = Math.max(0, Math.min(255, base[1] + k)); d[i + 2] = Math.max(0, Math.min(255, base[2] + k)); d[i + 3] = 255 * alpha;
  }
  g.putImageData(img, 0, 0);
}
const TEX = {
  asphalt: canvasTexture(512, (g, n) => {          // asfalto: grano fino, piedritas claras, manchas y alguna grieta
    const r = rand(7); noise(g, n, [58, 61, 66], 26, r);
    for (let i = 0; i < 2600; i++) { g.fillStyle = `rgba(${170 + r() * 60},${170 + r() * 60},${170 + r() * 60},${0.25 + r() * 0.35})`; g.fillRect(r() * n, r() * n, 1 + r() * 1.6, 1 + r() * 1.6); }
    for (let i = 0; i < 14; i++) { g.fillStyle = `rgba(20,22,26,${0.08 + r() * 0.1})`; g.beginPath(); g.ellipse(r() * n, r() * n, 20 + r() * 60, 10 + r() * 40, r() * 3, 0, 7); g.fill(); }
    g.strokeStyle = 'rgba(15,15,18,0.45)'; g.lineWidth = 1.2;
    for (let i = 0; i < 4; i++) { let x = r() * n, y = r() * n; g.beginPath(); g.moveTo(x, y); for (let k = 0; k < 8; k++) { x += (r() - 0.5) * 30; y += r() * 18; g.lineTo(x, y); } g.stroke(); }
  }),
  grass: canvasTexture(512, (g, n) => {            // pasto: verde con briznas claras y oscuras
    const r = rand(11); noise(g, n, [86, 128, 52], 30, r);
    for (let i = 0; i < 9000; i++) {
      const x = r() * n, y = r() * n, l = 3 + r() * 6, dark = r() < 0.5;
      g.strokeStyle = dark ? `rgba(40,80,25,${0.35 + r() * 0.3})` : `rgba(150,190,80,${0.25 + r() * 0.3})`;
      g.lineWidth = 1; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 3, y - l); g.stroke();
    }
    for (let i = 0; i < 30; i++) { g.fillStyle = `rgba(120,110,60,${0.06 + r() * 0.08})`; g.beginPath(); g.arc(r() * n, r() * n, 15 + r() * 45, 0, 7); g.fill(); }
  }),
  mud: canvasTexture(256, (g, n) => {              // barro: marrón con charquitos brillantes y huellas
    const r = rand(5); noise(g, n, [92, 62, 38], 30, r);
    for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(55,35,20,${0.25 + r() * 0.3})`; g.beginPath(); g.ellipse(r() * n, r() * n, 8 + r() * 26, 5 + r() * 14, r() * 3, 0, 7); g.fill(); }
    for (let i = 0; i < 10; i++) { g.fillStyle = `rgba(140,110,80,${0.25 + r() * 0.2})`; g.beginPath(); g.ellipse(r() * n, r() * n, 4 + r() * 10, 2 + r() * 6, r() * 3, 0, 7); g.fill(); }
    g.strokeStyle = 'rgba(40,25,15,0.5)'; g.lineWidth = 6;
    for (const x of [0.3, 0.7]) { g.beginPath(); g.moveTo(x * n, 0); g.lineTo(x * n + 6, n); g.stroke(); }   // surcos
  }),
  checker: canvasTexture(256, (g, n) => {
    const k = n / 8;
    for (let i = 0; i < 8; i++) for (let j = 0; j < 2; j++) { g.fillStyle = (i + j) % 2 ? '#111' : '#f4f4f4'; g.fillRect(i * k, j * n / 2, k, n / 2); }
  }, false),
};

try {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  const PR_MAX = Math.min(window.devicePixelRatio, 2);
  let pixelRatio = PR_MAX;
  renderer.setPixelRatio(pixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.78;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.setAttribute('aria-label', 'Pista 3D del experimento 8: estadio con público, calle de pits y coche de rally');

  const scene = new THREE.Scene();
  // Cielo, neblina y luz ambiental: los pone buildVenue (venue.js).
  const camera = new THREE.PerspectiveCamera(55, 1, 0.6, 5000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.maxPolarAngle = Math.PI / 2 - 0.05; controls.enabled = false;
  const hemi = new THREE.HemisphereLight('#dfefff', '#5d7f33', 1.2); scene.add(hemi);
  const sun = new THREE.DirectionalLight('#fff1d6', 4.3);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.radius = 4; sun.shadow.bias = -0.0004;
  Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 400 });
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);
  const SUN_DIR = new THREE.Vector3(-0.45, 0.8, 0.4).normalize();
  const headlights = [], snapC = new THREE.Vector3();

  const mats = {};
  const mat = (color, o = {}) => (mats[color + JSON.stringify(o)] ??= new THREE.MeshStandardMaterial({ color, roughness: 0.85, side: THREE.DoubleSide, ...o }));

  const OFFSET = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };   // pintura sobre el asfalto sin parpadeo
  // Piezas fijas: se juntan por material y se convierten en un solo objeto por material.
  function mergeInto(target, meshes, shadows = true) {
    const by = new Map();
    for (const m of meshes) { if (!by.has(m.material)) by.set(m.material, []); by.get(m.material).push(m.geometry); }
    for (const [material, geos] of by) {
      const list = geos.map(g => { const n = g.index ? g.toNonIndexed() : g; if (!n.attributes.uv) n.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n.attributes.position.count * 2), 2)); return n; });
      const mesh = new THREE.Mesh(mergeGeometries(list), material); mesh.receiveShadow = true; mesh.castShadow = shadows && !material.polygonOffset && !material.map; target.add(mesh);
      geos.forEach(g => g.dispose());
    }
  }
  // Bloque 3D que sigue la pista (rampas, losas del puente, bordillos).
  function band({ s0, s1, d, width, top, bottom = top - 0.2, material, steps }) {
    steps ??= Math.max(2, Math.ceil((s1 - s0) / 1.5));
    const topFn = typeof top === 'function' ? top : () => top;
    const botFn = typeof bottom === 'function' ? bottom : () => bottom;
    const pos = [], idx = [];
    for (let i = 0; i <= steps; i++) {
      const f = i / steps, s = s0 + (s1 - s0) * f, ht = topFn(f, s), hb = botFn(f, s);
      for (const [o, h] of [[d + width / 2, ht], [d - width / 2, ht], [d + width / 2, hb], [d - width / 2, hb]]) {
        const p = at(s, o, h); pos.push(p.x, p.y, p.z);
      }
      if (i < steps) { const k = i * 4; idx.push(k, k + 4, k + 1, k + 1, k + 4, k + 5, k, k + 2, k + 4, k + 4, k + 2, k + 6, k + 1, k + 5, k + 3, k + 3, k + 5, k + 7); }
    }
    const e = steps * 4; idx.push(0, 1, 2, 2, 1, 3, e, e + 2, e + 1, e + 1, e + 2, e + 3);
    let g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
    g = g.toNonIndexed(); g.computeVertexNormals();
    const m = new THREE.Mesh(g, material); m.castShadow = m.receiveShadow = true; m.userData.batch = true; return m;
  }
  // Cinta plana con coordenadas de textura (asfalto, pintura, barro, línea a cuadros).
  function ribbon({ s0, s1, d, width, h, material, tile = 4, stepLen = 1.5, uTiles = null }) {
    const steps = Math.max(1, Math.ceil((s1 - s0) / stepLen));
    const pos = [], uv = [], idx = [];
    for (let i = 0; i <= steps; i++) {
      const s = s0 + (s1 - s0) * i / steps;
      const a = at(s, d + width / 2, h), b = at(s, d - width / 2, h);
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      const v = s / tile;
      uv.push(0, v, uTiles ?? width / tile, v);
      if (i < steps) { const k = i * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals();
    if (g.attributes.normal.getY(0) < 0) { for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]]; g.setIndex(idx); g.computeVertexNormals(); }   // cara hacia arriba
    const m = new THREE.Mesh(g, material); m.receiveShadow = true; m.userData.batch = true; return m;
  }

  // ---------- entorno fijo: pasto, asfalto en TODA la pista, pintura, pianos, conos ----------
  {
    const fixed = [], stat = m => fixed.push(m);
    const gt = TEX.grass.clone(); gt.needsUpdate = true; gt.repeat.set(500, 500);
    // Pasto cortado en franjas (como un estadio) + manchas grandes para que no se vea repetido.
    const grassMat = new THREE.MeshStandardMaterial({ map: gt, roughness: 1 });
    grassMat.onBeforeCompile = sh => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
        .replace('#include <map_fragment>', `#include <map_fragment>
          float stripe = step(0.5, fract((vWP.x * 0.8 + vWP.z * 0.6) / 14.0));
          float blot = 0.5 + 0.5 * sin(vWP.x * 0.021) * sin(vWP.z * 0.017 + 1.3);
          diffuseColor.rgb *= mix(0.88, 1.06, stripe) * mix(0.9, 1.08, blot);`);
    };
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000, 100, 100), grassMat);
    grass.rotation.x = -Math.PI / 2; grass.position.y = -0.06; grass.receiveShadow = true; scene.add(grass);
    const asphalt = new THREE.MeshStandardMaterial({ map: TEX.asphalt, roughness: 0.92, metalness: 0.0 });
    stat(ribbon({ s0: 0, s1: L, d: 0, width: 2 * HALF + 1.2, h: 0.0, material: asphalt, tile: 5 }));
    // Banquina de tierra/grava a cada lado (visual: fuera de ahí ya es accidente "sale de la pista").
    const gravel = mat('#9b8f78', { roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    for (const side of [-1, 1]) stat(ribbon({ s0: 0, s1: L, d: side * (HALF + 2.3), width: 2.2, h: -0.02, material: gravel }));
    // Pintura: bordes blancos continuos, separadores blancos discontinuos y eje central amarillo.
    const white = mat('#f2f2ee', { roughness: 0.6, ...OFFSET }), yellow = mat('#f2c230', { roughness: 0.6, ...OFFSET });
    for (const side of [-1, 1]) stat(ribbon({ s0: 0, s1: L, d: side * (HALF - 0.2), width: 0.2, h: 0.012, material: white, stepLen: 2 }));
    for (let k = 1; k < LANES; k++) {
      const d = laneD(k - 0.5), isCenter = Math.abs(d) < 0.01;
      for (let s = 0; s < L; s += isCenter ? 8 : 9) stat(ribbon({ s0: s, s1: s + (isCenter ? 4.5 : 3), d, width: isCenter ? 0.18 : 0.14, h: 0.012, material: isCenter ? yellow : white, stepLen: 1 }));
    }
    // Pianos rojo y blanco solo en las curvas; bordillo de concreto en las rectas.
    for (const side of [-1, 1]) for (let s = 0; s < L; s += 2) {
      const curve = inCurve(s + 1);
      stat(band({ s0: s, s1: s + 2, d: side * (HALF + 0.85), width: 0.9, top: curve ? 0.07 : 0.05, bottom: -0.05,
        material: curve ? mat(((s / 2) % 2) ? '#f4f1e8' : '#d8332a', { roughness: 0.55 }) : mat('#b9b6ae'), steps: 1 }));
    }
    // Línea de salida y meta a cuadros.
    const chk = new THREE.MeshStandardMaterial({ map: TEX.checker, roughness: 0.6, ...OFFSET, polygonOffsetFactor: -3 });
    stat(ribbon({ s0: 0.2, s1: 2.2, d: 0, width: 2 * HALF, h: 0.015, material: chk, tile: 2, uTiles: 1, stepLen: 2 }));
    mergeInto(scene, fixed, false);
    // Conos: hilera por dentro y por fuera de cada curva y a la salida (instanciados: un solo dibujo).
    const conePos = [];
    for (let s = 0; s < L; s += 6) if (inCurve(s)) { conePos.push([s, HALF + 2.0]); if (Math.round(s / 6) % 3 === 0) conePos.push([s, -(HALF + 2.0)]); }
    for (let s = -24; s <= 24; s += 4) if (s !== 0) for (const side of [-1, 1]) conePos.push([(s + L) % L, side * (HALF + 2.0)]);
    const parts = [
      [new THREE.ConeGeometry(0.17, 0.62, 18, 1, true).translate(0, 0.35, 0), mat('#ff5a0a', { roughness: 0.45 })],
      [new THREE.CylinderGeometry(0.105, 0.125, 0.12, 18, 1, true).translate(0, 0.42, 0), mat('#f5f5f5', { roughness: 0.4 })],
      [new THREE.BoxGeometry(0.42, 0.04, 0.42).translate(0, 0.02, 0), mat('#ff5a0a', { roughness: 0.6 })],
    ];
    const tmp = new THREE.Object3D();
    for (const [geo, m] of parts) {
      const inst = new THREE.InstancedMesh(geo, m, conePos.length); inst.castShadow = true;
      conePos.forEach(([s, d], i) => { tmp.position.copy(at(s, d, 0)); tmp.rotation.y = yawOf(center(s)[2]); tmp.updateMatrix(); inst.setMatrixAt(i, tmp.matrix); });
      scene.add(inst);
    }
  }

  const venue = buildVenue({ scene, renderer, sun, sunDir: SUN_DIR, at, center, L, S, R, HALF, mat, infield: false });

  // ---------- hora del día: día, atardecer y noche ----------
  // Solo cambia la luz y el cielo: la carrera, la física y los datos son los mismos.
  // Importante para la fluidez: la cantidad de luces NUNCA cambia. Si cambiara, el navegador tendría que recompilar
  // todos los materiales (eso era la "trabada" larga al pasar a noche). De noche los reflectores se simulan con el
  // mismo sol (luz blanca desde arriba) y los faros son una sola luz que siempre existe y de día queda en 0.
  const TIMES = {
    dia: { sun: new THREE.Vector3(-0.45, 0.8, 0.4), sunColor: '#fff1d6', sunI: 4.3, sky: '#dfefff', ground: '#5d7f33', hemiI: 1.2,
           turbidity: 2.6, rayleigh: 2.2, fog: '#b9cfe2', exposure: 0.78, env: 0.4, lamps: 1.6, towers: 0, heads: false, skyOn: true },
    atardecer: { sun: new THREE.Vector3(-0.85, 0.06, 0.5), sunColor: '#ff9a4d', sunI: 3.2, sky: '#ffb27a', ground: '#3d3324', hemiI: 0.7,
           turbidity: 10, rayleigh: 3.6, fog: '#e08a5c', exposure: 0.95, env: 0.22, lamps: 2.4, towers: 0, heads: false, skyOn: true },
    noche: { sun: new THREE.Vector3(0.15, 0.95, -0.2), sunColor: '#dfe6ff', sunI: 1.25, sky: '#26324d', ground: '#0d130c', hemiI: 0.22,
           turbidity: 1, rayleigh: 0.2, fog: '#070b14', exposure: 1.0, env: 0.05, lamps: 6, towers: 1, heads: true, skyOn: false },
  };
  let timeOfDay = 'dia';
  function setTimeOfDay(name) {
    const t = TIMES[name] ?? TIMES.dia; timeOfDay = name in TIMES ? name : 'dia';
    SUN_DIR.copy(t.sun).normalize();
    sun.color.set(t.sunColor); sun.intensity = t.sunI;
    hemi.color.set(t.sky); hemi.groundColor.set(t.ground); hemi.intensity = t.hemiI;
    const u = venue.sky.material.uniforms;
    u.sunPosition.value.copy(SUN_DIR); u.turbidity.value = t.turbidity; u.rayleigh.value = t.rayleigh;
    u.mieCoefficient.value = name === 'atardecer' ? 0.012 : 0.004;
    venue.sky.visible = t.skyOn;
    scene.background = t.skyOn ? null : new THREE.Color('#05070d');
    scene.fog.color.set(t.fog);
    renderer.toneMappingExposure = t.exposure;
    scene.environmentIntensity = t.env;
    if (venue.lamps.material) venue.lamps.material.emissiveIntensity = t.lamps;
    headlights.forEach(h => { h.lamps.visible = t.heads; if (h.beam) h.beam.intensity = t.heads ? 60 : 0; });
    stars.visible = name === 'noche';
  }
  // Estrellas para la noche (un solo objeto de puntos).
  const stars = (() => {
    const n = 1500, pos = new Float32Array(n * 3), r = venue.rng(9);
    for (let i = 0; i < n; i++) {
      const th = r() * Math.PI * 2, ph = Math.acos(0.15 + r() * 0.85), R0 = 3000;
      pos.set([R0 * Math.sin(ph) * Math.cos(th), R0 * Math.cos(ph), R0 * Math.sin(ph) * Math.sin(th)], i * 3);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const p = new THREE.Points(g, new THREE.PointsMaterial({ color: '#ffffff', size: 2.2, sizeAttenuation: false, fog: false }));
    p.visible = false; scene.add(p); return p;
  })();
  // ---------- mapa en vivo y distancia entre los dos coches ----------
  const mini = document.getElementById('minimap'), gapChip = document.getElementById('gapChip');
  const miniCtx = mini?.getContext('2d');
  const miniPts = []; for (let s = 0; s < L; s += 6) { const c = center(s); miniPts.push([c[0], c[1]]); }
  const mb = miniPts.reduce((b, [x, y]) => [Math.min(b[0], x), Math.max(b[1], x), Math.min(b[2], y), Math.max(b[3], y)], [1e9, -1e9, 1e9, -1e9]);
  const pad = 2 * HALF + 10, mScale = mini ? Math.min((mini.width - 24) / (mb[1] - mb[0] + pad), (mini.height - 24) / (mb[3] - mb[2] + pad)) : 1;
  const toMini = (x, y) => [mini.width / 2 + (x - (mb[0] + mb[1]) / 2) * mScale, mini.height / 2 - (y - (mb[2] + mb[3]) / 2) * mScale];
  let miniLast = 0;
  function drawMini(now, frame) {
    if (!miniCtx || now - miniLast < 66) return;           // 15 veces por segundo es suficiente
    miniLast = now;
    const g = miniCtx; g.clearRect(0, 0, mini.width, mini.height);
    g.lineJoin = 'round'; g.beginPath(); miniPts.forEach(([x, y], k) => { const [u, v] = toMini(x, y); k ? g.lineTo(u, v) : g.moveTo(u, v); }); g.closePath();
    g.strokeStyle = '#3a4653'; g.lineWidth = 2 * HALF * mScale + 4; g.stroke();
    g.strokeStyle = '#59677433'; g.lineWidth = 1; g.stroke();
    const [sx, sy] = toMini(...center(0)); g.fillStyle = '#e9eef2'; g.fillRect(sx - 1.5, sy - 7, 3, 14);   // línea de salida
    const dot = (obj, color) => { if (!obj.visible) return; const [u, v] = toMini(obj.position.x, -obj.position.z); g.beginPath(); g.arc(u, v, 5, 0, Math.PI * 2); g.fillStyle = color; g.fill(); g.lineWidth = 2; g.strokeStyle = '#0b1016'; g.stroke(); };
    dot(ghost, '#5a8ee8'); dot(car, '#ffcc1a');
    if (gapChip) {
      const gf = current?.ghost?.frames;
      if (!gf) { gapChip.hidden = true; return; }
      const a = current.frames[Math.min(frame, current.frames.length - 1)]?.s ?? 0, b = gf[Math.min(frame, gf.length - 1)]?.s ?? 0, d = a - b;
      gapChip.hidden = false;
      gapChip.classList.toggle('behind', d < 0);
      gapChip.innerHTML = Math.abs(d) < 1 ? 'Empatados' : d > 0 ? `PPO <b>+${d.toFixed(0)} m</b> adelante` : `Maestro <b>+${(-d).toFixed(0)} m</b> adelante`;
    }
  }
  window.addEventListener('rally8:time', e => setTimeOfDay(e.detail));
  try { const v = new URLSearchParams(location.search).get('hora') || localStorage.getItem('rally-hora'); if (v) setTimeOfDay(v); } catch {}
  const infield = buildInfield({ scene, S, R, HALF, makeCar: color => (models.coche ? prepCar(models.coche, 1, color) : null) });

  // ---------- modelos 3D ----------
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const load = url => loader.loadAsync(url).then(g => g.scene).catch(err => { console.warn('No cargó', url, err); return null; });
  const models = {};
  const ready = Promise.all([Promise.resolve(null), load(CAR.url).then(m => m ?? (Object.assign(CAR, CAR_OLD), load(CAR_OLD.url))), load('models3d/valla.glb')])
    .then(([estadio, coche, valla]) => { Object.assign(models, { estadio, coche, valla }); });

  // Decoración de rally: amarillo con negro, número en las puertas y franja en el capó (se pinta una vez).
  function liveryTex(text, w = 512, h = 512, bg = '#ffffff', fg = '#111111') {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
    g.fillStyle = bg; g.beginPath(); g.roundRect(8, 8, w - 16, h - 16, 60); g.fill();
    g.lineWidth = 14; g.strokeStyle = fg; g.stroke();
    g.fillStyle = fg; g.font = `900 ${Math.round(h * 0.62)}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, w / 2, h / 2 + 10);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  function stripeTex() {
    const c = document.createElement('canvas'); c.width = 512; c.height = 128; const g = c.getContext('2d');
    g.fillStyle = '#111'; g.fillRect(0, 0, 512, 128); g.fillStyle = '#e8202a'; g.fillRect(0, 44, 512, 40);
    g.fillStyle = '#fff'; g.font = '900 52px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('RALLY IA', 256, 66);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  let liveryDone = false;
  function paintLivery(car, color = '#ffc414') {
    car.traverse(o => {
      if (!o.isMesh) return;
      const n = o.material?.name ?? '';
      if (/^Paint 1/.test(n)) { o.material = o.material.clone(); o.material.color.set(color); o.material.map = null; o.material.metalness = 0.25; o.material.roughness = 0.32; o.material.needsUpdate = true; }
      if (/^Paint 2/.test(n)) { o.material = o.material.clone(); o.material.color.set('#16181b'); o.material.map = null; o.material.needsUpdate = true; }
    });
  }
  function addDecals(car, body) {
    // Se proyectan sobre la carrocería ya escalada y girada (coordenadas del grupo del coche).
    car.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(car), size = box.getSize(new THREE.Vector3());
    const numMat = new THREE.MeshStandardMaterial({ map: liveryTex('6'), transparent: true, polygonOffset: true, polygonOffsetFactor: -4, roughness: 0.4 });
    const stripeMat = new THREE.MeshStandardMaterial({ map: stripeTex(), polygonOffset: true, polygonOffsetFactor: -4, roughness: 0.35 });
    const targets = []; car.traverse(o => { if (o.isMesh && /^(Body|Paint)/.test(o.material?.name ?? '') || (o.isMesh && /^Paint/.test(o.material?.name ?? ''))) targets.push(o); });
    const painted = []; car.traverse(o => { if (o.isMesh && /^Paint/.test(o.material?.name ?? '')) painted.push(o); });
    const yMid = box.min.y + size.y * 0.42;
    for (const side of [1, -1]) {
      const pos = new THREE.Vector3(side * size.x / 2, yMid, box.min.z + size.z * 0.5), rot = new THREE.Euler(0, side * Math.PI / 2, 0);
      for (const m of painted) { const g = new DecalGeometry(m, pos, rot, new THREE.Vector3(0.62, 0.62, 0.8)); if (g.attributes.position.count) body.add(new THREE.Mesh(g, numMat)); }
    }
    const hood = new THREE.Vector3(0, box.max.y, box.min.z + size.z * 0.78), hrot = new THREE.Euler(-Math.PI / 2, 0, Math.PI / 2);
    for (const m of painted) { const g = new DecalGeometry(m, hood, hrot, new THREE.Vector3(1.15, 0.32, 2.4)); if (g.attributes.position.count) body.add(new THREE.Mesh(g, stripeMat)); }
  }
  function prepCar(src, opacity = 1, plain = null) {
    // g (posición y rumbo) -> body (cabeceo, balanceo, compresión) -> carrocería. Las ruedas cuelgan de g,
    // así quedan apoyadas en el suelo mientras la carrocería se inclina sobre la suspensión.
    const g = new THREE.Group(), body = new THREE.Group();
    g.add(body);
    const car = src.clone(true);
    if (CAR.livery && opacity === 1) paintLivery(car, plain ?? undefined);
    const groups = []; if (CAR.wheelGroup) car.traverse(o => { if (CAR.wheelGroup.test(o.name)) groups.push(o); });
    // El modelo trae las ruedas delanteras ya viradas (y todas con un giro guardado). Si se hacen girar así,
    // el eje queda torcido y la rueda bambolea. Se enderezan: el eje de cada rueda queda cruzado al coche.
    groups.forEach(o => o.quaternion.identity());
    car.updateMatrixWorld(true);
    // Hacia dónde mira el modelo: del centro de las ruedas traseras al de las delanteras.
    if (groups.length === 4) {
      const ctr = o => new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());
      const f = new THREE.Vector3(), r = new THREE.Vector3();
      groups.forEach(o => (/Front/.test(o.name) ? f : r).add(ctr(o)));
      const dir = f.sub(r); car.rotation.y = Math.atan2(-dir.x, dir.z);
    } else car.rotation.y = CAR.yaw ?? 0;
    car.updateMatrixWorld(true);
    const box0 = new THREE.Box3().setFromObject(car), size = box0.getSize(new THREE.Vector3());
    car.scale.multiplyScalar(CAR.length / Math.max(size.x, size.z));      // largo real del coche (m)
    car.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(car), c = box.getCenter(new THREE.Vector3());
    car.position.set(-c.x, -box.min.y, -c.z);
    body.add(car); g.updateMatrixWorld(true);
    car.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = !plain;
      if (opacity < 1) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = opacity; o.material.depthWrite = false; }
    });
    if (CAR.livery && opacity === 1 && !plain) addDecals(car, body);
    const wheels = [];
    const mount = (parts, front, still = []) => {
      // pivot: vira con el volante · spin: gira con la distancia. Las pastillas de freno no giran.
      const wb = new THREE.Box3(); parts.forEach(p => wb.expandByObject(p));
      const wc = wb.getCenter(new THREE.Vector3()); g.worldToLocal(wc);
      const radius = wb.getSize(new THREE.Vector3()).y / 2;
      const pivot = new THREE.Group(), spin = new THREE.Group();
      pivot.position.copy(wc); g.add(pivot); pivot.add(spin);
      parts.forEach(p => spin.attach(p)); still.forEach(p => pivot.attach(p));
      wheels.push({ pivot, spin, front: front ?? wc.z > 0, radius });
    };
    if (groups.length === 4) {
      for (const grp of groups) {
        const parts = [], still = [];
        grp.traverse(o => { if (o.isMesh) (/BrakePad/.test(o.name) ? still : parts).push(o); });
        mount(parts, /Front/.test(grp.name), still);
      }
    } else {
      const found = []; car.traverse(o => { if (o.isMesh && CAR.wheel?.test(o.name)) found.push(o); });
      found.forEach(o => mount([o]));
    }
    // Luces de freno: dos barras rojas atrás que se encienden cuando el pedal frena.
    const brake = new THREE.Group(), bm = new THREE.MeshBasicMaterial({ color: '#ff2a1a', transparent: opacity < 1, opacity });
    const bb = new THREE.Box3().setFromObject(body);
    for (const sx of [-1, 1]) { const m = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.07, 0.06), bm); m.position.set(sx * 0.52, bb.max.y * 0.62, bb.min.z + 0.05); brake.add(m); }
    brake.visible = false; body.add(brake);
    // Faros: dos luces blancas adelante y un cono de luz sobre la pista. Solo se encienden de noche.
    if (!plain) {
      const lights = new THREE.Group(), hm = new THREE.MeshBasicMaterial({ color: '#fffbe8', transparent: opacity < 1, opacity });
      for (const sx of [-1, 1]) { const m = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.06), hm); m.position.set(sx * 0.6, bb.max.y * 0.5, bb.max.z - 0.05); lights.add(m); }
      let beam = null;
      if (opacity >= 1 && !headlights.some(h => h.beam)) {     // un solo cono de luz (el coche de la IA): una luz fija, siempre presente
        beam = new THREE.SpotLight('#fff4dc', 0, 70, 0.5, 0.45, 1.2);
        beam.position.set(0, bb.max.y * 0.55, bb.max.z); beam.target.position.set(0, 0, bb.max.z + 20);
        body.add(beam, beam.target);
      }
      lights.visible = false; body.add(lights); headlights.push({ lamps: lights, beam });
    }
    g.userData = { wheels, body, brake };
    g.rotation.order = 'YXZ'; body.rotation.order = 'YXZ';
    return g;
  }
  function fallbackCar(color) {
    const g = new THREE.Group(), body = new THREE.Group(); g.add(body);
    const b = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.9, 4.4), mat(color, { roughness: 0.3 })); b.position.y = 0.7; b.castShadow = true; body.add(b);
    g.userData = { wheels: [], body }; g.rotation.order = 'YXZ'; return g;
  }

  // ---------- obstáculos de la pista actual ----------
  let layoutGroup = null, layoutKey = null;
  const mudMat = new THREE.MeshStandardMaterial({ map: TEX.mud, roughness: 0.9, metalness: 0.0, ...OFFSET });
  const grassPatch = new THREE.MeshStandardMaterial({ map: TEX.grass, roughness: 1, ...OFFSET });
  const waterMat = new THREE.MeshStandardMaterial({ color: '#3b86c9', roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.78, ...OFFSET, polygonOffsetFactor: -3 });
  function buildLayout(layout) {
    if (layoutKey === layout.seed) return;
    layoutKey = layout.seed;
    if (layoutGroup) { scene.remove(layoutGroup); layoutGroup.traverse(o => o.geometry?.dispose?.()); }
    layoutGroup = new THREE.Group();
    const pieces = [];
    const add = o => (o.userData?.batch ? pieces.push(o) : layoutGroup.add(o), o);
    layout.ground.forEach((row, lane) => {
      const d = laneD(lane);
      for (let c = 0; c < row.length; c++) {
        const code = row[c], s0 = c * CELL, s1 = Math.min(L, s0 + CELL);
        if (code === 'L') add(ribbon({ s0, s1, d, width: W * 0.97, h: 0.03, material: mudMat, tile: 3 }));
        if (code === 'S') add(ribbon({ s0, s1, d, width: W * 0.97, h: 0.025, material: grassPatch, tile: 3 }));
        if (code === 'A') add(ribbon({ s0: s0 + 0.3, s1: s1 - 0.3, d, width: W * 0.9, h: 0.035, material: waterMat }));
        if (code === 'F') {
          add(band({ s0, s1, d, width: W, top: 0.02, bottom: -0.25, material: mat('#0b0806') }));
          for (const side of [-1, 1]) add(band({ s0, s1, d: d + side * (W / 2 - 0.15), width: 0.3, top: 0.25, material: mat('#ffcf33') }));
        }
        if (code === 'R') {
          const start = s1 - RAMP_LEN;
          add(band({ s0: start, s1, d, width: W * 0.96, top: f => P.ramp_height_m * f, bottom: 0, material: mat('#b9622f'), steps: 6 }));
          add(band({ s0: start + RAMP_LEN * 0.3, s1: start + RAMP_LEN * 0.36, d, width: W * 0.96, top: f => P.ramp_height_m * (0.3 + 0.06 * f) + 0.02, bottom: 0, material: mat('#f2b48b'), steps: 1 }));
        }
        if (code === 'B') {
          const s = s0 + CELL / 2;
          if (models.valla) {
            const v = models.valla.clone(true);
            v.traverse(o => { if (o.isMesh) o.castShadow = true; });
            const holder = new THREE.Group(); v.position.set(-2.09, 0, 0.72); holder.add(v);
            holder.position.copy(at(s, d, 0)); holder.rotation.y = yawOf(center(s)[2]); add(holder);   // cruzada (N7: antes quedaba de lado)
          } else {
            const m = new THREE.Mesh(new THREE.BoxGeometry(W * 0.9, 1.4, 0.4), mat('#d8332a')); m.position.copy(at(s, d, 0.7)); m.rotation.y = yawOf(center(s)[2]); add(m);
          }
        }
      }
    });
    layout.deck.forEach((row, lane) => {
      const d = laneD(lane), H = P.deck_height_m;
      for (let c = 0; c < row.length; c++) {
        const code = row[c], s0 = c * CELL, s1 = s0 + CELL;
        const deckMat = mat('#8e9399', { roughness: 0.8 });
        if (code === 'P') add(band({ s0, s1, d, width: W, top: H, bottom: H - 0.45, material: deckMat }));
        if (code === 'G') {
          const a = (CELL - 6) / 2;
          add(band({ s0, s1: s0 + a, d, width: W, top: H, bottom: H - 0.45, material: deckMat }));
          add(band({ s0: s1 - a, s1, d, width: W, top: H, bottom: H - 0.45, material: deckMat }));
        }
        if (code === 'D') add(band({ s0, s1, d, width: W, top: f => H * (1 - f), bottom: f => Math.max(0, H * (1 - f) - 0.45), material: deckMat, steps: 6 }));
        if (code === 'P' || code === 'G') {
          for (const side of [-1, 1]) {
            const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.6, H - 0.45, 0.6), mat('#c9c6bf'));
            pillar.position.copy(at(s0 + CELL / 2, d + side * (W / 2 - 0.4), (H - 0.45) / 2)); pillar.castShadow = true; add(pillar);
          }
          for (const side of [-1, 1]) add(band({ s0, s1, d: d + side * (W / 2 - 0.08), width: 0.16, top: H + 0.5, bottom: H, material: mat('#ffffff') }));
        }
      }
    });
    mergeInto(layoutGroup, pieces);
    scene.add(layoutGroup);
  }

  // Estadio: se estira para que el óvalo quede adentro (modelo de Poly by Google).
  function buildStadium() {
    if (!models.estadio) return;
    const st = models.estadio.clone(true);
    let pitch = null, base = null;
    st.traverse(o => {
      if (!o.isMesh) return;
      if (o.name === 'Box007_1_12') pitch = o;
      if (o.name === 'Box007_1_3') base = o;
      if (/^Box007_1_(5|6|7|8|9|10|11)$/.test(o.name)) o.visible = false;
    });
    st.updateMatrixWorld(true);
    const pb = new THREE.Box3().setFromObject(pitch ?? st), pc = pb.getCenter(new THREE.Vector3()), ps = pb.getSize(new THREE.Vector3());
    if (pitch) pitch.visible = false;
    if (base) base.visible = false;
    const holder = new THREE.Group(); st.position.set(-pc.x, -pb.min.y, -pc.z); holder.add(st);
    holder.rotation.y = Math.PI / 2;
    const halfX = S / 2 + R + HALF + 12, halfZ = R + HALF + 12;
    holder.scale.set(halfZ / (ps.x / 2), 1.8, halfX / (ps.z / 2));
    holder.traverse(o => { if (o.isMesh) o.receiveShadow = true; });
    scene.add(holder);
  }
  const startLamps = [];
  const startGate = new THREE.Group(); {
    // Arco de salida y meta, CRUZADO sobre la pista (N7: antes quedaba de lado).
    const gc = document.createElement('canvas'); gc.width = 1024; gc.height = 128; const gg = gc.getContext('2d');
    gg.fillStyle = '#111'; gg.fillRect(0, 0, 1024, 128);
    for (let i = 0; i < 32; i++) for (let j = 0; j < 2; j++) { gg.fillStyle = (i + j) % 2 ? '#fff' : '#111'; gg.fillRect(i * 16, j * 16, 16, 16); gg.fillRect(1024 - (i + 1) * 16, 96 + j * 16, 16, 16); }
    gg.fillStyle = '#ffd12e'; gg.font = '900 64px system-ui, sans-serif'; gg.textAlign = 'center'; gg.textBaseline = 'middle'; gg.fillText('SALIDA · META', 512, 66);
    const gt = new THREE.CanvasTexture(gc); gt.colorSpace = THREE.SRGBColorSpace;
    const bannerMat = [mat('#16181b'), mat('#16181b'), mat('#16181b'), mat('#16181b'), new THREE.MeshStandardMaterial({ map: gt, emissive: '#ffffff', emissiveMap: gt, emissiveIntensity: 0.35 }), new THREE.MeshStandardMaterial({ map: gt, emissive: '#ffffff', emissiveMap: gt, emissiveIntensity: 0.35 })];
    const banner = new THREE.Mesh(new THREE.BoxGeometry(2 * HALF + 2, 1.6, 0.5), bannerMat); banner.position.y = 6.2; banner.castShadow = true; startGate.add(banner);
    for (const x of [-(HALF + 1), HALF + 1]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.6, 7, 0.6), mat('#2a2f36', { metalness: 0.6, roughness: 0.4 })); post.position.set(x, 3.5, 0); post.castShadow = true; startGate.add(post); }
    const lampG = new THREE.SphereGeometry(0.22, 12, 8);
    for (let i = 0; i < 5; i++) { const m = new THREE.MeshStandardMaterial({ color: '#3a1010', emissive: '#ff2a1a', emissiveIntensity: 0 }); startLamps.push(m); const l = new THREE.Mesh(lampG, m); l.scale.setScalar(1.6); l.position.set(-2 + i, 5.1, 0.3); startGate.add(l); }
    startGate.position.copy(at(1.2, 0, 0)); startGate.rotation.y = yawOf(center(1.2)[2]); scene.add(startGate);
  }

  // ---------- "Ver lo que ve la IA": 8 puntos de la pista a 0,5–5 s adelante ----------
  const LOOK_T = cfg.sensors?.course_times_s ?? [0.5, 1, 1.5, 2, 2.5, 3, 4, 5];
  const LOOK_MIN_V = cfg.sensors?.course_min_speed_mps ?? 5, LOOK_MAX = cfg.sensors?.course_max_m ?? 200;
  const lookDots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.45, 16, 10), new THREE.MeshBasicMaterial({ toneMapped: false }), LOOK_T.length);
  const lookLine = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(3 * (LOOK_T.length + 1)), 3)), new THREE.LineBasicMaterial({ color: '#7fe9ff', transparent: true, opacity: 0.85 }));
  lookDots.visible = lookLine.visible = false; lookDots.frustumCulled = lookLine.frustumCulled = false;
  scene.add(lookDots, lookLine);
  let showLook = false;
  window.addEventListener('rally8:look', e => { showLook = e.detail; lookDots.visible = lookLine.visible = showLook; });
  const lookTmp = new THREE.Object3D(), C_STRAIGHT = new THREE.Color('#47df9a'), C_BEND = new THREE.Color('#ffb02e');
  function updateLook(sNow, speed, carPos) {
    if (!showLook) return;
    const v = Math.max(speed, LOOK_MIN_V), pos = lookLine.geometry.attributes.position;
    pos.setXYZ(0, carPos.x, carPos.y + 0.6, carPos.z);
    LOOK_T.forEach((t, i) => {
      const s = sNow + Math.min(v * t, LOOK_MAX), p = at(s, 0, 0.6);
      lookTmp.position.copy(p); lookTmp.updateMatrix(); lookDots.setMatrixAt(i, lookTmp.matrix);
      lookDots.setColorAt(i, inCurve(s) ? C_BEND : C_STRAIGHT); pos.setXYZ(i + 1, p.x, p.y, p.z);
    });
    lookDots.instanceMatrix.needsUpdate = true; if (lookDots.instanceColor) lookDots.instanceColor.needsUpdate = true; pos.needsUpdate = true;
  }

  // ---------- marcas de llanta y salpicaduras ----------
  const MARKS = 2500;
  const marks = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.24, 0.7).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.55, depthWrite: false, ...OFFSET, polygonOffsetFactor: -4 }), MARKS);
  marks.count = 0; marks.frustumCulled = false; scene.add(marks);
  let markNext = 0, lastMark = null;
  function clearMarks() { marks.count = 0; markNext = 0; lastMark = null; marks.instanceMatrix.needsUpdate = true; }
  const mObj = new THREE.Object3D();
  function addMarks(pos, h, color) {
    if (lastMark && lastMark.distanceTo(pos) < 0.45) return;
    lastMark = pos.clone();
    const dir = new THREE.Vector3(Math.cos(h), 0, -Math.sin(h)), left = new THREE.Vector3(-Math.sin(h), 0, -Math.cos(h));
    for (const side of [-0.78, 0.78]) {
      mObj.position.copy(pos).addScaledVector(dir, -1.35).addScaledVector(left, side); mObj.position.y = 0.02;
      mObj.rotation.set(0, yawOf(h), 0); mObj.updateMatrix();
      marks.setMatrixAt(markNext, mObj.matrix); marks.setColorAt(markNext, color);
      markNext = (markNext + 1) % MARKS; marks.count = Math.min(MARKS, marks.count + 1);
    }
    marks.instanceMatrix.needsUpdate = true; if (marks.instanceColor) marks.instanceColor.needsUpdate = true;
  }
  const DROPS = 260;
  const drops = new THREE.InstancedMesh(new THREE.SphereGeometry(0.07, 6, 4), new THREE.MeshStandardMaterial({ roughness: 0.6 }), DROPS);
  drops.frustumCulled = false; scene.add(drops);
  const dropState = Array.from({ length: DROPS }, () => ({ life: 0, g: 9.81, p: new THREE.Vector3(), v: new THREE.Vector3() }));
  let dropNext = 0;
  const hide = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < DROPS; i++) drops.setMatrixAt(i, hide);
  function splash(pos, h, speed, color) {
    const dir = new THREE.Vector3(Math.cos(h), 0, -Math.sin(h)), left = new THREE.Vector3(-Math.sin(h), 0, -Math.cos(h));
    for (let k = 0; k < 3; k++) {
      const d = dropState[dropNext]; d.life = 0.7 + Math.random() * 0.5; d.g = 9.81;
      d.p.copy(pos).addScaledVector(dir, -1.4).addScaledVector(left, (Math.random() < 0.5 ? -1 : 1) * 0.8); d.p.y = 0.15;
      d.v.copy(dir).multiplyScalar(-0.15 * speed - Math.random() * 2).addScaledVector(left, (Math.random() - 0.5) * 3); d.v.y = 1.5 + Math.random() * 2.5;
      drops.setColorAt(dropNext, color); dropNext = (dropNext + 1) % DROPS;
    }
    if (drops.instanceColor) drops.instanceColor.needsUpdate = true;
  }
  function updateDrops(dt) {
    dropState.forEach((d, i) => {
      if (d.life <= 0) return;
      d.life -= dt; d.v.y -= d.g * dt; d.p.addScaledVector(d.v, dt);
      if (d.p.y < 0.03) { d.p.y = 0.03; d.v.set(0, 0, 0); }
      mObj.position.copy(d.p); mObj.rotation.set(0, 0, 0); mObj.scale.setScalar(d.life > 0 ? 1 : 0); mObj.updateMatrix();
      drops.setMatrixAt(i, d.life > 0 ? mObj.matrix : hide);
    });
    mObj.scale.setScalar(1);
    drops.instanceMatrix.needsUpdate = true;
  }
  // ---------- intento 3: polvo, humo, chispas, confeti y la línea que siguió cada coche ----------
  // Nubes: imágenes redondas y suaves que siempre miran a la cámara, crecen y se desvanecen.
  const puffTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
    const r = g.createRadialGradient(32, 32, 2, 32, 32, 32); r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.55, 'rgba(255,255,255,0.6)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c);
  })();
  const PUFFS = 140;
  const puffs = Array.from({ length: PUFFS }, () => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTex, transparent: true, depthWrite: false, opacity: 0 }));
    sp.visible = false; scene.add(sp); return { sp, life: 0, max: 1, v: new THREE.Vector3(), grow: 1, alpha: 0.5 };
  });
  let puffNext = 0;
  function puff(pos, color, { size = 1.5, grow = 2.4, life = 1.2, alpha = 0.55, up = 0.6, spread = 0.5 } = {}) {
    const q = puffs[puffNext]; puffNext = (puffNext + 1) % PUFFS;
    q.life = q.max = life * (0.7 + Math.random() * 0.6); q.grow = grow; q.alpha = alpha;
    q.sp.position.copy(pos); q.sp.position.x += (Math.random() - 0.5) * spread; q.sp.position.z += (Math.random() - 0.5) * spread;
    q.sp.position.y += size * 0.3; q.sp.scale.setScalar(size); q.sp.material.color.set(color); q.sp.material.opacity = alpha; q.sp.visible = true;
    q.v.set((Math.random() - 0.5) * 0.8, up * (0.6 + Math.random() * 0.8), (Math.random() - 0.5) * 0.8);
  }
  function updatePuffs(dt) {
    for (const q of puffs) {
      if (q.life <= 0) continue;
      q.life -= dt; if (q.life <= 0) { q.sp.visible = false; continue; }
      q.sp.position.addScaledVector(q.v, dt); q.sp.scale.addScalar(q.grow * dt);
      q.sp.material.opacity = q.alpha * (q.life / q.max);
    }
  }
  function burst(pos, color, n, { speed = 6, up = 5, life = 1.2, g = 9.81 } = {}) {
    for (let k = 0; k < n; k++) {
      const d = dropState[dropNext]; d.life = life * (0.6 + Math.random() * 0.8); d.g = g;
      d.p.copy(pos); d.p.y += 0.5;
      d.v.set((Math.random() - 0.5) * speed, up * (0.4 + Math.random()), (Math.random() - 0.5) * speed);
      drops.setColorAt(dropNext, typeof color === 'function' ? color() : color); dropNext = (dropNext + 1) % DROPS;
    }
    if (drops.instanceColor) drops.instanceColor.needsUpdate = true;
  }
  const C_SPARK = new THREE.Color('#ffb53a'), CONFETTI = ['#ffc320', '#ff4d4d', '#4dd2ff', '#7dff7a', '#ffffff', '#d07bff'].map(c => new THREE.Color(c));
  const CRASH = new Set(['sale_de_la_pista', 'hace_un_trompo', 'choca_con_la_valla', 'aterrizaje_duro', 'cae_en_foso', 'cae_del_puente', 'sale_volando_de_la_pista', 'choca_con_el_borde_del_puente']);
  let shake = 0, lastFxFrame = -1, celebrated = false, puffAcc = 0;
  // Línea que siguió cada coche: una cinta pegada al piso (amarilla = coche principal, azul = el otro).
  function makeTrail(color) {
    const N = 9000, geo = new THREE.BufferGeometry(), pos = new Float32Array(N * 2 * 3), idx = new Uint32Array((N - 1) * 6);
    for (let i = 0; i < N - 1; i++) idx.set([2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2], i * 6);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setIndex(new THREE.BufferAttribute(idx, 1)); geo.setDrawRange(0, 0);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide, ...OFFSET, polygonOffsetFactor: -5 }));
    mesh.frustumCulled = false; mesh.renderOrder = 2; scene.add(mesh);
    return { mesh, pos, n: 0, N, last: null, idx: 0 };
  }
  const trailCar = makeTrail('#ffc320'), trailGhost = makeTrail('#5a8ee8');
  let showTrails = true;
  function clearTrail(t) { t.n = 0; t.last = null; t.idx = 0; t.mesh.geometry.setDrawRange(0, 0); }
  // La cinta se arma con los datos de la reproducción (no con los cuadros dibujados): así queda igual
  // de lisa en un computador lento. `upto` = hasta qué dato ya pasó el coche.
  const trailTmp = new THREE.Vector3();
  function addTrail(t, list, upto) {
    if (upto + 1 < (t.idx ?? 0)) clearTrail(t);
    for (let k = t.idx ?? 0; k <= upto && t.n < t.N; k++) {
      const a = list[k]; trailTmp.set(a[0], a[2], -a[1]);
      if (t.last && t.last.distanceTo(trailTmp) < 0.5) continue;
      t.last = (t.last ?? new THREE.Vector3()).copy(trailTmp);
      const lx = -Math.sin(a[3]) * 0.16, lz = -Math.cos(a[3]) * 0.16, y = a[2] + 0.05;
      t.pos.set([a[0] + lx, y, -a[1] + lz, a[0] - lx, y, -a[1] - lz], t.n * 6); t.n++;
    }
    t.idx = upto + 1;
    t.mesh.geometry.attributes.position.needsUpdate = true; t.mesh.geometry.setDrawRange(0, Math.max(0, (t.n - 1) * 6));
  }
  window.addEventListener('rally8:trails', e => { showTrails = e.detail; trailCar.mesh.visible = trailGhost.mesh.visible = showTrails; });
  const C_MARK = new THREE.Color('#141414'), C_MUD_MARK = new THREE.Color('#3b2716'), C_MUD = new THREE.Color('#5a3b24'), C_WATER = new THREE.Color('#cfe8ff');

  // ---------- coches ----------
  let car = fallbackCar('#ffc320'), ghost = fallbackCar('#5a8ee8');
  ghost.visible = false; scene.add(car); scene.add(ghost);
  ready.then(() => {
    if (models.coche) {
      scene.remove(car); scene.remove(ghost);
      car = prepCar(models.coche); ghost = prepCar(models.coche, 0.45); ghost.visible = !!current?.ghostPoses;
      const paints = []; ghost.traverse(o => { if (o.isMesh && /^Paint/.test(o.material?.name ?? '')) paints.push(o); });
      ghost.traverse(o => {
        if (!o.isMesh) return;
        const n = o.name + ' ' + (o.material?.name ?? '');
        const tint = paints.length ? paints.includes(o) : !/wheel|glass|window|vidrio/i.test(n);
        if (tint) { o.material.color = new THREE.Color('#5a8ee8'); o.material.map = null; o.material.needsUpdate = true; }
      });
      scene.add(car); scene.add(ghost);
    }
    if (current) { layoutKey = null; buildLayout(current.layout); }
    infield.addCars();
    message.hidden = true;
  });

  // ---------- reproducción ----------
  let current = null, playStart = 0, stepMs = 250, paused = false, pausedAt = 0;
  function posesOf(frames) {   // lista de poses por subpaso; también devuelve cuántas hay por paso
    const out = [frames[0].poses[frames[0].poses.length - 1]];
    for (let i = 1; i < frames.length; i++) out.push(...frames[i].poses);
    const sub = Math.max(...frames.slice(1, 6).map(f => f.poses.length), 1);
    return { list: out, sub };
  }
  function receive(d) {
    if (!d) return;
    if (d.layout && (!current || current.layout.seed !== d.layout.seed)) buildLayout(d.layout);
    current = { ...d, poses: posesOf(d.frames), ghostPoses: d.ghost ? posesOf(d.ghost.frames) : null };
    ghost.visible = !!d.ghost;
    clearMarks(); clearTrail(trailCar); clearTrail(trailGhost); lastFxFrame = -1; celebrated = false;
    stepMs = d.stepMs; playStart = performance.now() - (d.frameIndex * stepMs); paused = d.paused; pausedAt = d.frameIndex * stepMs;
    lead = d.frameIndex === 0 ? COUNTDOWN_MS : 0; lastLights = -1;   // cuenta regresiva solo al empezar la carrera desde la salida
  }
  window.addEventListener('rally8:scenario', e => receive(e.detail));
  window.addEventListener('rally8:control', e => {
    const c = e.detail;
    if ('paused' in c) { if (c.paused) { pausedAt = elapsed(); paused = true; } else { paused = false; playStart = performance.now() - pausedAt; } }
    if ('seekMs' in c) { pausedAt = c.seekMs; playStart = performance.now() - c.seekMs; }   // para pruebas y capturas
  });
  // ---------- semáforo de salida: 5 luces rojas que se encienden una por una y luego todas en verde ----------
  const COUNTDOWN_MS = 3400;
  let lead = 0, lastLights = -1;
  const overlay = document.getElementById('startLights'), dots = overlay ? [...overlay.querySelectorAll('i')] : [];
  function startLights(tAll) {
    // 0: apagado · 1..5: rojas encendidas · 6: verde · 7: terminado
    let k = 7;
    if (lead) { if (tAll < 400) k = 0; else if (tAll < 2900) k = 1 + Math.min(4, Math.floor((tAll - 400) / 500)); else if (tAll < lead + 1300) k = 6; }
    if (k === lastLights) return;
    const prev = lastLights; lastLights = k;
    startLamps.forEach((m, j) => {
      const on = (k >= 1 && k <= 5 && j < k) || k === 6;
      m.emissive.set(k === 6 ? '#2bff6a' : '#ff2a1a'); m.color.set(on ? (k === 6 ? '#0f3a1c' : '#3a1010') : '#151515'); m.emissiveIntensity = on ? 3.2 : 0;
    });
    if (overlay) {
      overlay.hidden = k === 7 || !lead;
      overlay.classList.toggle('go', k === 6);
      dots.forEach((d, j) => d.classList.toggle('on', (k >= 1 && k <= 5 && j < k) || k === 6));
    }
    if (k >= 1 && k <= 5 && k !== prev) sound.beep(false);
    if (k === 6 && prev !== 6) { sound.beep(true); sound.cheer(0.6); }
  }

  // ---------- sonido: motores y estadio, hechos con Web Audio (sin archivos) ----------
  // El navegador solo deja sonar después de un clic, por eso hay un botón "Activar sonido".
  const sound = (() => {
    let ctx = null, master, engineBus, crowdBus, cars = [], crowd, crowdGain, on = false;
    const vol = { engine: 0.6, crowd: 0.5 };
    try { const v = JSON.parse(localStorage.getItem('rally-sonido') || '{}'); Object.assign(vol, v); } catch {}
    function noiseBuffer() {
      const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = b.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; b0 = 0.997 * b0 + w * 0.029; b1 = 0.985 * b1 + w * 0.032; b2 = 0.95 * b2 + w * 0.048; d[i] = (b0 + b1 + b2 + w * 0.02) * 0.9; }
      return b;
    }
    function makeEngine(level) {
      const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      o1.type = 'sawtooth'; o2.type = 'square'; o2.detune.value = -1200 + 7;
      f.type = 'lowpass'; f.frequency.value = 600; f.Q.value = 3; g.gain.value = 0;
      const m2 = ctx.createGain(); m2.gain.value = 0.35;
      o1.connect(f); o2.connect(m2).connect(f); f.connect(g).connect(engineBus); o1.start(); o2.start();
      return { o1, o2, f, g, level };
    }
    function start() {
      if (ctx) return;
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination);
      engineBus = ctx.createGain(); engineBus.gain.value = vol.engine * 0.35; engineBus.connect(master);
      crowdBus = ctx.createGain(); crowdBus.gain.value = vol.crowd; crowdBus.connect(master);
      cars = [makeEngine(1), makeEngine(0.45)];
      crowd = ctx.createBufferSource(); crowd.buffer = noiseBuffer(); crowd.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.6;
      crowdGain = ctx.createGain(); crowdGain.gain.value = 0.25;
      crowd.connect(bp).connect(crowdGain).connect(crowdBus); crowd.start();
    }
    return {
      get on() { return on; },
      setOn(v) { if (v) start(); on = v; if (ctx) { v ? ctx.resume() : ctx.suspend(); } },
      setVol(k, v) { vol[k] = v; try { localStorage.setItem('rally-sonido', JSON.stringify(vol)); } catch {} if (!ctx) return; (k === 'engine' ? engineBus : crowdBus).gain.setTargetAtTime(k === 'engine' ? v * 0.35 : v, ctx.currentTime, 0.05); },
      vol,
      // speed en m/s, pedal de −1 a 1; visible = si ese coche está en la carrera
      engine(i, speed, pedal, visible, paused) {
        const c = cars[i]; if (!ctx || !on || !c) return;
        const now = ctx.currentTime, gear = Math.min(5, Math.floor(speed / 9)), inGear = (speed - gear * 9) / 9;
        const rpm = 0.25 + 0.75 * Math.max(0, Math.min(1, inGear)) + (speed > 1 ? 0 : 0);
        const hz = 38 + rpm * 70 + gear * 6;
        c.o1.frequency.setTargetAtTime(hz, now, 0.06); c.o2.frequency.setTargetAtTime(hz, now, 0.06);
        c.f.frequency.setTargetAtTime(380 + 1600 * Math.max(0, pedal) * rpm + speed * 10, now, 0.08);
        c.g.gain.setTargetAtTime(visible && !paused ? c.level * (0.35 + 0.65 * Math.max(0.15, pedal)) : 0, now, 0.1);
      },
      crowdLevel(x) { if (ctx && on) crowdGain.gain.setTargetAtTime(x, ctx.currentTime, 0.4); },
      cheer(amount = 1) { if (!ctx || !on) return; const now = ctx.currentTime; crowdGain.gain.cancelScheduledValues(now); crowdGain.gain.setTargetAtTime(0.25 + 0.9 * amount, now, 0.15); crowdGain.gain.setTargetAtTime(0.25, now + 1.6, 1.2); },
      beep(go) {
        if (!ctx || !on) return; const o = ctx.createOscillator(), g = ctx.createGain(), now = ctx.currentTime;
        o.type = 'square'; o.frequency.value = go ? 1046 : 523; g.gain.setValueAtTime(0.0001, now); g.gain.exponentialRampToValueAtTime(0.18, now + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, now + (go ? 0.6 : 0.18));
        o.connect(g).connect(master); o.start(now); o.stop(now + 0.7);
      },
      crash() {
        if (!ctx || !on) return; const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(), now = ctx.currentTime;
        s.buffer = noiseBuffer(); f.type = 'lowpass'; f.frequency.value = 700; g.gain.setValueAtTime(0.8 * vol.engine + 0.1, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
        s.connect(f).connect(g).connect(master); s.start(now); s.stop(now + 0.7);
      },
    };
  })();
  window.addEventListener('rally8:sound', e => { const d = e.detail; if ('on' in d) sound.setOn(d.on); if ('engine' in d) sound.setVol('engine', d.engine); if ('crowd' in d) sound.setVol('crowd', d.crowd); });
  window.rallyV8Sound = sound;
  function elapsed() { return paused ? pausedAt : performance.now() - playStart; }
  function sample({ list, sub }, t) {
    const pos = t / stepMs * sub;
    const i = Math.min(list.length - 2, Math.max(0, Math.floor(pos))), f = Math.min(1, Math.max(0, pos - i));
    const a = list[i], b = list[i + 1] ?? a;
    const mix = k => (a[k] ?? 0) + ((b[k] ?? 0) - (a[k] ?? 0)) * f;
    let dh = b[3] - a[3]; if (dh > Math.PI) dh -= 2 * Math.PI; if (dh < -Math.PI) dh += 2 * Math.PI;
    return { x: mix(0), y: mix(1), z: mix(2), h: a[3] + dh * f, steer: mix(4), slip: mix(5),
             pitch: mix(6), roll: mix(7), heave: mix(8),
             dist: Math.hypot(b[0] - a[0], b[1] - a[1]), end: pos >= list.length - 1 };
  }
  // "Exagerar": multiplica cabeceo y balanceo para verlos mejor en una exposición (los datos no cambian).
  let exag = 1, drawDt = 1 / 60;
  window.addEventListener('rally8:exaggerate', e => { exag = e.detail; });
  function place(obj, st) {
    obj.position.set(st.x, st.z, -st.y);
    obj.rotation.y = yawOf(st.h);
    const body = obj.userData.body;
    // Temblor: la física guarda la suspensión cada 0,025 s y vibra muy rápido (rebotes de 10–20 por segundo).
    // Para el dibujo se filtra (≈0,15 s) y así la carrocería se mueve suave; los datos y el examen no cambian.
    const sm = obj.userData.smooth ??= { pitch: st.pitch, roll: st.roll, heave: st.heave };
    const a = 1 - Math.exp(-drawDt / 0.15);
    sm.pitch += (st.pitch - sm.pitch) * a; sm.roll += (st.roll - sm.roll) * a; sm.heave += (st.heave - sm.heave) * a;
    body.rotation.x = sm.pitch * exag;                             // + = trompa abajo (al frenar)
    body.rotation.z = sm.roll * exag;                              // + = se inclina a la derecha (curva a la izquierda)
    body.position.y = -sm.heave * 0.6 * Math.min(exag, 2);         // se hunde al aterrizar, se estira en el aire
    // Ruedas (N7): una rueda real a 100 km/h da ~12 vueltas por segundo; dibujada a 60 cuadros por segundo
    // parece temblar o girar al revés (efecto "rueda de carreta"). Se limita el giro dibujado por cuadro.
    // El ángulo del volante se suaviza un poco SOLO en el dibujo (≈0,1 s); los datos no cambian.
    obj.userData.steerShown = (obj.userData.steerShown ?? 0) + (st.steer - (obj.userData.steerShown ?? 0)) * (1 - Math.exp(-drawDt / 0.1));
    // Metros recorridos desde el cuadro anterior (antes se sumaba la distancia entre dos datos en cada cuadro).
    const u = obj.userData, moved = u.px === undefined ? 0 : Math.hypot(st.x - u.px, st.y - u.py);
    u.px = st.x; u.py = st.y;
    for (const w of obj.userData.wheels) {
      w.spin.rotation.x += 0.6 * Math.tanh(moved / (w.radius || CAR.wheelRadius || 0.33) / 0.6);
      w.pivot.rotation.y = w.front ? obj.userData.steerShown : 0;
    }
  }

  // ---------- cámaras ----------
  let mode = 'follow';
  const camPos = new THREE.Vector3(0, 120, 260), camLook = new THREE.Vector3();
  function setMode(m) {
    mode = m; controls.enabled = m === 'free';
    for (const b of tools.querySelectorAll('button[data-cam]')) b.setAttribute('aria-pressed', String(b.dataset.cam === m));
    if (m === 'free') { controls.target.copy(car.position); camera.position.set(car.position.x + 40, 40, car.position.z + 60); }
  }
  for (const b of tools.querySelectorAll('button[data-cam]')) b.onclick = () => setMode(b.dataset.cam);
  let camHeading = 0;
  function updateCamera(dt, st) {
    if (mode === 'free') { controls.update(); return; }
    // La cámara sigue la dirección en que el coche SE MUEVE (rumbo + deslizamiento): en un derrape se ve el coche cruzado.
    const course = st.h + st.slip;
    let dh = course - camHeading; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
    camHeading += dh * (1 - Math.exp(-dt * 3));
    const h = camHeading;
    const dir = new THREE.Vector3(Math.cos(h), 0, -Math.sin(h)), left = new THREE.Vector3(-Math.sin(h), 0, -Math.cos(h));
    const desired = new THREE.Vector3(), look = car.position.clone();
    if (mode === 'follow') { desired.copy(car.position).addScaledVector(dir, -8.2).add(new THREE.Vector3(0, 2.9, 0)); look.addScaledVector(dir, 12).y += 0.9; }
    else if (mode === 'side') { desired.copy(car.position).addScaledVector(left, 20).addScaledVector(dir, -3).add(new THREE.Vector3(0, 7, 0)); look.addScaledVector(dir, 4); }
    else { desired.set(0, 400, 0.01); look.set(0, 0, 0); }
    const k = 1 - Math.exp(-dt * (mode === 'top' ? 2 : mode === 'side' ? 4 : 5));
    camPos.lerp(desired, k); camLook.lerp(look, k); camera.position.copy(camPos); camera.lookAt(camLook);
  }

  function resize() { camera.aspect = host.clientWidth / Math.max(1, host.clientHeight); camera.updateProjectionMatrix(); renderer.setSize(host.clientWidth, host.clientHeight); }
  new ResizeObserver(resize).observe(host); resize();
  receive(window.rallyV8Scenario);
  setMode('follow');
  // Calidad automática: si el computador no llega a ~45 cuadros por segundo, se baja la resolución interna
  // (lo que más pesa) paso a paso; si aun así no alcanza, se apagan las sombras. "Alta" lo deja todo al máximo.
  let quality = 'auto', fps = 60, slowFor = 0, fastFor = 0;
  function applyQuality() {
    renderer.setPixelRatio(pixelRatio); resize();
  }
  window.addEventListener('rally8:quality', e => {
    quality = e.detail; slowFor = fastFor = 0;
    pixelRatio = quality === 'baja' ? Math.min(PR_MAX, 0.75) : quality === 'media' ? Math.min(PR_MAX, 1) : PR_MAX;
    renderer.shadowMap.enabled = quality !== 'baja'; sun.castShadow = quality !== 'baja';
    applyQuality();
  });
  function tune(raw) {
    fps += (1 / Math.max(raw, 1e-3) - fps) * 0.06;
    if (quality !== 'auto' || document.hidden) return;
    if (fps < 42) { slowFor += raw; fastFor = 0; } else if (fps > 57) { fastFor += raw; slowFor = 0; } else slowFor = fastFor = 0;
    if (slowFor > 1.5) {
      slowFor = 0;
      if (pixelRatio > 0.7) { pixelRatio = Math.max(0.7, pixelRatio - 0.25); applyQuality(); fps = 50; }
      else if (sun.castShadow) { sun.castShadow = false; fps = 50; }
    } else if (fastFor > 8 && pixelRatio < Math.min(PR_MAX, 1.25) && sun.castShadow) { fastFor = 0; pixelRatio = Math.min(PR_MAX, pixelRatio + 0.25); applyQuality(); }
  }
  let last = performance.now(), fpsShown = 0;
  renderer.setAnimationLoop(now => {
    const raw = (now - last) / 1000;
    const dt = Math.min(0.1, raw); last = now; drawDt = dt;
    tune(raw);
    if (now - fpsShown > 500) { fpsShown = now; window.dispatchEvent(new CustomEvent('rally8:fps', { detail: { fps: Math.round(fps), pixelRatio, shadows: sun.castShadow, quality } })); }
    if (current) {
      const tAll = elapsed(), t = Math.max(0, tAll - lead);
      startLights(tAll);
      const st = sample(current.poses, t); place(car, st);
      const upto = (ps, tt) => Math.min(ps.list.length - 1, Math.max(0, Math.floor(tt / stepMs * ps.sub)));
      if (showTrails) addTrail(trailCar, current.poses.list, upto(current.poses, t));
      if (current.ghostPoses) { place(ghost, sample(current.ghostPoses, t)); if (showTrails) addTrail(trailGhost, current.ghostPoses.list, upto(current.ghostPoses, t)); }
      const frame = Math.min(current.frames.length - 1, Math.floor(t / stepMs) + 1);
      const f = current.frames[frame];
      const speed = f?.speed_mps ?? 0, ground = st.z < 0.1 && !f?.airborne;
      if (car.userData.brake) car.userData.brake.visible = (f?.pedal ?? 0) < -0.15;
      const counting = lead && tAll < lead;
      sound.engine(0, counting ? 0 : speed, counting ? 0.25 : (f?.pedal ?? 0), true, paused);
      const gfr = current.ghost?.frames?.[Math.min(frame, (current.ghost?.frames?.length ?? 1) - 1)];
      sound.engine(1, counting ? 0 : (gfr?.speed_mps ?? 0), counting ? 0.25 : (gfr?.pedal ?? 0), ghost.visible, paused);
      if (!paused && ground && speed > 2) {
        const sliding = Math.abs(st.slip) > 0.1 || f?.wheelspin;
        if (f?.terrain_here === 'lodo') { addMarks(car.position, st.h, C_MUD_MARK); splash(car.position, st.h, speed, C_MUD); }
        else if (f?.terrain_here === 'agua') splash(car.position, st.h, speed, C_WATER);
        else if (sliding) addMarks(car.position, st.h, C_MARK);
        else lastMark = null;
        // Polvo y humo detrás del coche: café en pasto, blanco si las llantas patinan, gris suave en asfalto rápido.
        const rear = car.position.clone().addScaledVector(new THREE.Vector3(Math.cos(st.h), 0, -Math.sin(st.h)), -1.7); rear.y += 0.25;
        // Cantidad por segundo (no por cuadro): se ve igual en un computador rápido o lento.
        const emit = (rate, color, o) => { puffAcc += rate * dt; const k = Math.min(3, Math.floor(puffAcc)); puffAcc -= Math.floor(puffAcc); for (let i = 0; i < k; i++) puff(rear, color, o); };
        if (f?.terrain_here === 'pasto') emit(34, '#a08a5c', { alpha: 0.6, grow: 2.8 });
        else if (f?.terrain_here === 'lodo') emit(18, '#6b4a30', { alpha: 0.5, size: 1.1 });
        else if (sliding && f?.terrain_here !== 'agua') emit(40, '#e8e8e8', { alpha: 0.55, grow: 3 });
        else if (speed > 14) emit(7, '#b9b4a8', { alpha: 0.22, size: 1.0, grow: 1.8, life: 0.9 });
      }
      // Choque: humo oscuro, chispas y un sacudón de cámara. Meta: confeti.
      if (!paused && frame !== lastFxFrame) {
        lastFxFrame = frame;
        if ((f?.events ?? []).some(e => CRASH.has(e))) {
          for (let k = 0; k < 10; k++) puff(car.position, k % 2 ? '#3a3a3a' : '#8a8378', { size: 2.4, grow: 4, life: 1.8, alpha: 0.7, up: 1.6, spread: 3.5 });
          burst(car.position, C_SPARK, 30, { speed: 9, up: 4, life: 0.7 }); shake = 0.45; sound.crash(); sound.cheer(0.35);
        }
        if (!celebrated && f?.termination_cause === 'vuelta_completada') {
          sound.cheer(1); celebrated = true; burst(car.position, () => CONFETTI[Math.floor(Math.random() * CONFETTI.length)], 200, { speed: 12, up: 11, life: 3.2, g: 4 });
        }
      }
      updatePuffs(paused ? 0 : dt);
      updateDrops(paused ? 0 : dt);
      // El sol (y su sombra) acompaña al coche para que la sombra sea nítida donde se mira.
      sun.position.copy(car.position).addScaledVector(SUN_DIR, 150); sun.target.position.copy(car.position);
      stars.position.copy(camera.position);
      drawMini(now, frame);
      venue.update(now / 1000, car.position); infield.update(now / 1000);
      const prevF = current.frames[Math.max(0, frame - 1)], frac = Math.min(1, (t % stepMs) / stepMs);
      updateLook((prevF?.s ?? 0) + ((f?.s ?? 0) - (prevF?.s ?? 0)) * frac, speed, car.position);
      window.dispatchEvent(new CustomEvent('rally8:tick', { detail: { frame, end: st.end } }));
      updateCamera(dt, st);
      if (shake > 0 && mode !== 'free') { shake -= dt; const a = Math.max(0, shake) * 0.9; camera.position.x += (Math.random() - 0.5) * a; camera.position.y += (Math.random() - 0.5) * a; }
    }
    renderer.render(scene, camera);
  });
  world.classList.add('has-3d'); tools.hidden = false;
  window.rallyV8Scene = { setMode, camera, renderer, scene, controls, fx: { puff, burst } };
} catch (error) {
  host.replaceChildren(); world.classList.remove('has-3d'); tools.hidden = true;
  message.hidden = false; message.textContent = 'Este navegador no pudo iniciar WebGL. La tabla y las curvas siguen disponibles.';
  console.error('Rally v8 3D:', error);
}
