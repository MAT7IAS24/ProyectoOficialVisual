import * as THREE from 'three';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { GLTFLoader } from './vendor/three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from './vendor/three/addons/libs/meshopt_decoder.module.js';
import { DecalGeometry } from './vendor/three/addons/geometries/DecalGeometry.js';
import { buildVenue } from './venue.js';

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
const data = window.rallyV7Data;
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
  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.78;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.setAttribute('aria-label', 'Pista 3D del experimento 6: estadio con público, coche de rally y carrocería que se inclina sobre la suspensión');

  const scene = new THREE.Scene();
  // Cielo, neblina y luz ambiental: los pone buildVenue (venue.js).
  const camera = new THREE.PerspectiveCamera(55, 1, 0.3, 6000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.maxPolarAngle = Math.PI / 2 - 0.05; controls.enabled = false;
  scene.add(new THREE.HemisphereLight('#dfefff', '#5d7f33', 1.2));
  const sun = new THREE.DirectionalLight('#fff1d6', 4.3);
  sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096); sun.shadow.radius = 4; sun.shadow.bias = -0.0004;
  Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 400 });
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);
  const SUN_DIR = new THREE.Vector3(-0.45, 0.8, 0.4).normalize();

  const mats = {};
  const mat = (color, o = {}) => (mats[color + JSON.stringify(o)] ??= new THREE.MeshStandardMaterial({ color, roughness: 0.85, side: THREE.DoubleSide, ...o }));

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
    const m = new THREE.Mesh(g, material); m.castShadow = m.receiveShadow = true; return m;
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
    const m = new THREE.Mesh(g, material); m.receiveShadow = true; return m;
  }

  // ---------- entorno fijo: pasto, asfalto en TODA la pista, pintura, pianos, conos ----------
  {
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
    scene.add(ribbon({ s0: 0, s1: L, d: 0, width: 2 * HALF + 1.2, h: 0.0, material: asphalt, tile: 5 }));
    // Banquina de tierra/grava a cada lado (visual: fuera de ahí ya es accidente "sale de la pista").
    const gravel = mat('#9b8f78', { roughness: 1 });
    for (const side of [-1, 1]) scene.add(ribbon({ s0: 0, s1: L, d: side * (HALF + 2.3), width: 2.2, h: -0.02, material: gravel }));
    // Pintura: bordes blancos continuos, separadores blancos discontinuos y eje central amarillo.
    const white = mat('#f2f2ee', { roughness: 0.6 }), yellow = mat('#f2c230', { roughness: 0.6 });
    for (const side of [-1, 1]) scene.add(ribbon({ s0: 0, s1: L, d: side * (HALF - 0.2), width: 0.2, h: 0.012, material: white, stepLen: 2 }));
    for (let k = 1; k < LANES; k++) {
      const d = laneD(k - 0.5), isCenter = Math.abs(d) < 0.01;
      for (let s = 0; s < L; s += isCenter ? 8 : 9) scene.add(ribbon({ s0: s, s1: s + (isCenter ? 4.5 : 3), d, width: isCenter ? 0.18 : 0.14, h: 0.012, material: isCenter ? yellow : white, stepLen: 1 }));
    }
    // Pianos rojo y blanco solo en las curvas; bordillo de concreto en las rectas.
    for (const side of [-1, 1]) for (let s = 0; s < L; s += 2) {
      const curve = inCurve(s + 1);
      scene.add(band({ s0: s, s1: s + 2, d: side * (HALF + 0.85), width: 0.9, top: curve ? 0.07 : 0.05, bottom: -0.05,
        material: curve ? mat(((s / 2) % 2) ? '#f4f1e8' : '#d8332a', { roughness: 0.55 }) : mat('#b9b6ae'), steps: 1 }));
    }
    // Línea de salida y meta a cuadros.
    const chk = new THREE.MeshStandardMaterial({ map: TEX.checker, roughness: 0.6 });
    scene.add(ribbon({ s0: 0.2, s1: 2.2, d: 0, width: 2 * HALF, h: 0.015, material: chk, tile: 2, uTiles: 1, stepLen: 2 }));
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

  const venue = buildVenue({ scene, renderer, sun, sunDir: SUN_DIR, at, center, L, S, R, HALF, mat });

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
  function paintLivery(car) {
    car.traverse(o => {
      if (!o.isMesh) return;
      const n = o.material?.name ?? '';
      if (/^Paint 1/.test(n)) { o.material = o.material.clone(); o.material.color.set('#ffc414'); o.material.map = null; o.material.metalness = 0.25; o.material.roughness = 0.32; o.material.needsUpdate = true; }
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
  function prepCar(src, opacity = 1) {
    // g (posición y rumbo) -> body (cabeceo, balanceo, compresión) -> carrocería. Las ruedas cuelgan de g,
    // así quedan apoyadas en el suelo mientras la carrocería se inclina sobre la suspensión.
    const g = new THREE.Group(), body = new THREE.Group();
    g.add(body);
    const car = src.clone(true);
    if (CAR.livery && opacity === 1) paintLivery(car);
    const groups = []; if (CAR.wheelGroup) car.traverse(o => { if (CAR.wheelGroup.test(o.name)) groups.push(o); });
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
      o.castShadow = true;
      if (opacity < 1) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = opacity; o.material.depthWrite = false; }
    });
    if (CAR.livery && opacity === 1) addDecals(car, body);
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
    g.userData = { wheels, body };
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
  const mudMat = new THREE.MeshStandardMaterial({ map: TEX.mud, roughness: 0.9, metalness: 0.0 });
  const grassPatch = new THREE.MeshStandardMaterial({ map: TEX.grass, roughness: 1 });
  const waterMat = new THREE.MeshStandardMaterial({ color: '#3b86c9', roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.78 });
  function buildLayout(layout) {
    if (layoutKey === layout.seed) return;
    layoutKey = layout.seed;
    if (layoutGroup) { scene.remove(layoutGroup); layoutGroup.traverse(o => o.geometry?.dispose?.()); }
    layoutGroup = new THREE.Group();
    const add = o => (layoutGroup.add(o), o);
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
    for (let i = 0; i < 5; i++) { const l = new THREE.Mesh(lampG, new THREE.MeshStandardMaterial({ color: '#ff3b30', emissive: '#ff3b30', emissiveIntensity: 1.5 })); l.position.set(-2 + i, 5.1, 0.3); startGate.add(l); }
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
  window.addEventListener('rally7:look', e => { showLook = e.detail; lookDots.visible = lookLine.visible = showLook; });
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
    new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.55, depthWrite: false }), MARKS);
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
  const dropState = Array.from({ length: DROPS }, () => ({ life: 0, p: new THREE.Vector3(), v: new THREE.Vector3() }));
  let dropNext = 0;
  const hide = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < DROPS; i++) drops.setMatrixAt(i, hide);
  function splash(pos, h, speed, color) {
    const dir = new THREE.Vector3(Math.cos(h), 0, -Math.sin(h)), left = new THREE.Vector3(-Math.sin(h), 0, -Math.cos(h));
    for (let k = 0; k < 3; k++) {
      const d = dropState[dropNext]; d.life = 0.7 + Math.random() * 0.5;
      d.p.copy(pos).addScaledVector(dir, -1.4).addScaledVector(left, (Math.random() < 0.5 ? -1 : 1) * 0.8); d.p.y = 0.15;
      d.v.copy(dir).multiplyScalar(-0.15 * speed - Math.random() * 2).addScaledVector(left, (Math.random() - 0.5) * 3); d.v.y = 1.5 + Math.random() * 2.5;
      drops.setColorAt(dropNext, color); dropNext = (dropNext + 1) % DROPS;
    }
    if (drops.instanceColor) drops.instanceColor.needsUpdate = true;
  }
  function updateDrops(dt) {
    dropState.forEach((d, i) => {
      if (d.life <= 0) return;
      d.life -= dt; d.v.y -= 9.81 * dt; d.p.addScaledVector(d.v, dt);
      if (d.p.y < 0.03) { d.p.y = 0.03; d.v.set(0, 0, 0); }
      mObj.position.copy(d.p); mObj.rotation.set(0, 0, 0); mObj.scale.setScalar(d.life > 0 ? 1 : 0); mObj.updateMatrix();
      drops.setMatrixAt(i, d.life > 0 ? mObj.matrix : hide);
    });
    mObj.scale.setScalar(1);
    drops.instanceMatrix.needsUpdate = true;
  }
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
    clearMarks();
    stepMs = d.stepMs; playStart = performance.now() - (d.frameIndex * stepMs); paused = d.paused; pausedAt = d.frameIndex * stepMs;
  }
  window.addEventListener('rally7:scenario', e => receive(e.detail));
  window.addEventListener('rally7:control', e => {
    const c = e.detail;
    if ('paused' in c) { if (c.paused) { pausedAt = elapsed(); paused = true; } else { paused = false; playStart = performance.now() - pausedAt; } }
  });
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
  let exag = 1;
  window.addEventListener('rally7:exaggerate', e => { exag = e.detail; });
  function place(obj, st) {
    obj.position.set(st.x, st.z, -st.y);
    obj.rotation.y = yawOf(st.h);
    const body = obj.userData.body;
    body.rotation.x = st.pitch * exag;                             // + = trompa abajo (al frenar)
    body.rotation.z = st.roll * exag;                              // + = se inclina a la derecha (curva a la izquierda)
    body.position.y = -st.heave * 0.6 * Math.min(exag, 2);         // se hunde al aterrizar, se estira en el aire
    // Ruedas (N7): una rueda real a 100 km/h da ~12 vueltas por segundo; dibujada a 60 cuadros por segundo
    // parece temblar o girar al revés (efecto "rueda de carreta"). Se limita el giro dibujado por cuadro.
    // El ángulo del volante se suaviza un poco SOLO en el dibujo (≈0,1 s); los datos no cambian.
    obj.userData.steerShown = (obj.userData.steerShown ?? 0) + (st.steer - (obj.userData.steerShown ?? 0)) * 0.35;
    for (const w of obj.userData.wheels) {
      w.spin.rotation.x += Math.min(0.42, st.dist / (w.radius || CAR.wheelRadius || 0.33));
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
    else { desired.set(0, 430, 0.01); look.set(0, 0, 0); }
    const k = 1 - Math.exp(-dt * (mode === 'top' ? 2 : mode === 'side' ? 4 : 5));
    camPos.lerp(desired, k); camLook.lerp(look, k); camera.position.copy(camPos); camera.lookAt(camLook);
  }

  function resize() { camera.aspect = host.clientWidth / Math.max(1, host.clientHeight); camera.updateProjectionMatrix(); renderer.setSize(host.clientWidth, host.clientHeight); }
  new ResizeObserver(resize).observe(host); resize();
  receive(window.rallyV7Scenario);
  setMode('follow');
  let last = performance.now();
  renderer.setAnimationLoop(now => {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (current) {
      const t = elapsed();
      const st = sample(current.poses, t); place(car, st);
      if (current.ghostPoses) place(ghost, sample(current.ghostPoses, t));
      const frame = Math.min(current.frames.length - 1, Math.floor(t / stepMs) + 1);
      const f = current.frames[frame];
      const speed = f?.speed_mps ?? 0, ground = st.z < 0.1 && !f?.airborne;
      if (!paused && ground && speed > 2) {
        const sliding = Math.abs(st.slip) > 0.1 || f?.wheelspin;
        if (f?.terrain_here === 'lodo') { addMarks(car.position, st.h, C_MUD_MARK); splash(car.position, st.h, speed, C_MUD); }
        else if (f?.terrain_here === 'agua') splash(car.position, st.h, speed, C_WATER);
        else if (sliding) addMarks(car.position, st.h, C_MARK);
        else lastMark = null;
      }
      updateDrops(paused ? 0 : dt);
      // El sol (y su sombra) acompaña al coche para que la sombra sea nítida donde se mira.
      sun.position.copy(car.position).addScaledVector(SUN_DIR, 150); sun.target.position.copy(car.position);
      venue.update(now / 1000, car.position);
      const prevF = current.frames[Math.max(0, frame - 1)], frac = Math.min(1, (t % stepMs) / stepMs);
      updateLook((prevF?.s ?? 0) + ((f?.s ?? 0) - (prevF?.s ?? 0)) * frac, speed, car.position);
      window.dispatchEvent(new CustomEvent('rally7:tick', { detail: { frame, end: st.end } }));
      updateCamera(dt, st);
    }
    renderer.render(scene, camera);
  });
  world.classList.add('has-3d'); tools.hidden = false;
  window.rallyV7Scene = { setMode, camera, renderer, scene, controls };
} catch (error) {
  host.replaceChildren(); world.classList.remove('has-3d'); tools.hidden = true;
  message.hidden = false; message.textContent = 'Este navegador no pudo iniciar WebGL. La tabla y las curvas siguen disponibles.';
  console.error('Rally v7 3D:', error);
}
