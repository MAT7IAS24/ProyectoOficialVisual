import * as THREE from 'three';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { GLTFLoader } from './vendor/three/addons/loaders/GLTFLoader.js';

// Vista 3D del N5. Solo dibuja: la forma de la pista, los obstáculos de cada pista y las poses del
// coche vienen de Python (pipeline_v5.py). Cada pose = [x, y, altura, rumbo de la carrocería,
// ángulo del volante, deslizamiento]. Con el volante se giran las ruedas delanteras y con el
// deslizamiento se dibujan las marcas de llanta: así se ve cuándo el coche derrapa de verdad.
// Conversión de coordenadas: Python (x, y, altura) -> Three.js (x, altura, -y).
const host = document.getElementById('scene3d');
const world = host.parentElement;
const message = document.getElementById('sceneStatus');
const tools = document.querySelector('.view-tools');
const data = window.rallyV5Data;
const cfg = data.config;
const LANES = cfg.track.lanes, W = cfg.track.lane_width_m, CELL = cfg.track.cell_m, HALF = LANES * W / 2;
const L = data.track_length, S = cfg.track.straight_m, R = cfg.track.radius_m;
const P = cfg.physics;
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
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.setAttribute('aria-label', 'Pista 3D del experimento 5: asfalto, líneas pintadas, conos y coche con llantas que derrapan');

  const scene = new THREE.Scene();
  const HORIZON = new THREE.Color('#cfe3f0');
  scene.fog = new THREE.Fog(HORIZON, 260, 1300);
  // Cielo: degradé de azul intenso arriba a blanquecino en el horizonte.
  {
    const sky = new THREE.Mesh(new THREE.SphereGeometry(2500, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color('#3f7fc4') }, bottom: { value: HORIZON } },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float h = clamp(vP.y * 2.2, 0.0, 1.0); gl_FragColor = vec4(mix(bottom, top, pow(h, 0.8)), 1.0); }',
    }));
    scene.add(sky);
  }
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 5000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.maxPolarAngle = Math.PI / 2 - 0.05; controls.enabled = false;
  scene.add(new THREE.HemisphereLight('#dfefff', '#5d7f33', 1.6));
  const sun = new THREE.DirectionalLight('#fff1d6', 3.2);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
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
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), new THREE.MeshStandardMaterial({ map: gt, roughness: 1 }));
    grass.rotation.x = -Math.PI / 2; grass.position.y = -0.05; grass.receiveShadow = true; scene.add(grass);
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

  // ---------- modelos 3D ----------
  const loader = new GLTFLoader();
  const load = url => loader.loadAsync(url).then(g => g.scene).catch(err => { console.warn('No cargó', url, err); return null; });
  const models = {};
  const ready = Promise.all([load('models3d/estadio.glb'), load('models3d/coche.glb'), load('models3d/valla.glb')])
    .then(([estadio, coche, valla]) => { Object.assign(models, { estadio, coche, valla }); });

  function prepCar(src, opacity = 1) {
    const g = new THREE.Group();
    const car = src.clone(true);
    car.scale.setScalar(0.01);                               // el modelo viene en centímetros
    const box = new THREE.Box3().setFromObject(car), c = box.getCenter(new THREE.Vector3());
    car.position.set(-c.x, -box.min.y, -c.z);
    g.add(car); g.updateMatrixWorld(true);
    const wheels = [];
    car.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = true;
      if (opacity < 1) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = opacity; o.material.depthWrite = false; }
      if (/Wheel/.test(o.name)) {
        o.geometry = o.geometry.clone(); o.geometry.computeBoundingBox();
        const wc = o.geometry.boundingBox.getCenter(new THREE.Vector3());
        o.geometry.translate(-wc.x, -wc.y, -wc.z); o.position.add(wc); o.rotation.order = 'YXZ';
        o.updateMatrixWorld(true);
        const wp = new THREE.Vector3(); o.getWorldPosition(wp);
        wheels.push({ mesh: o, front: wp.z > 0 });            // el modelo mira a +z: adelante = z positiva
      }
    });
    g.userData.wheels = wheels; g.rotation.order = 'YXZ';
    return g;
  }
  function fallbackCar(color) {
    const g = new THREE.Group();
    const b = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.9, 4.4), mat(color, { roughness: 0.3 })); b.position.y = 0.7; b.castShadow = true; g.add(b);
    g.userData.wheels = []; g.rotation.order = 'YXZ'; return g;
  }

  // ---------- obstáculos de la pista actual ----------
  let layoutGroup = null, layoutKey = null;
  const mudMat = new THREE.MeshStandardMaterial({ map: TEX.mud, roughness: 0.55, metalness: 0.05 });
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
            holder.position.copy(at(s, d, 0)); holder.rotation.y = yawOf(center(s)[2]) + Math.PI / 2; add(holder);
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
    const banner = new THREE.Mesh(new THREE.BoxGeometry(2 * HALF + 2, 1.4, 0.3), mat('#111111')); banner.position.y = 6; startGate.add(banner);
    for (const x of [-(HALF + 1), HALF + 1]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, 6.7, 0.4), mat('#222222')); post.position.set(x, 3.3, 0); startGate.add(post); }
    startGate.position.copy(at(1.2, 0, 0)); startGate.rotation.y = yawOf(center(1.2)[2]) + Math.PI / 2; scene.add(startGate);
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
    buildStadium();
    if (models.coche) {
      scene.remove(car); scene.remove(ghost);
      car = prepCar(models.coche); ghost = prepCar(models.coche, 0.45); ghost.visible = !!current?.ghostPoses;
      ghost.traverse(o => { if (o.isMesh && !/Wheel|Glass/.test(o.name)) { o.material.color = new THREE.Color('#5a8ee8'); } });
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
  window.addEventListener('rally5:scenario', e => receive(e.detail));
  window.addEventListener('rally5:control', e => {
    const c = e.detail;
    if ('paused' in c) { if (c.paused) { pausedAt = elapsed(); paused = true; } else { paused = false; playStart = performance.now() - pausedAt; } }
  });
  function elapsed() { return paused ? pausedAt : performance.now() - playStart; }
  function sample({ list, sub }, t) {
    const pos = t / stepMs * sub;
    const i = Math.min(list.length - 2, Math.max(0, Math.floor(pos))), f = Math.min(1, Math.max(0, pos - i));
    const a = list[i], b = list[i + 1] ?? a;
    let dh = b[3] - a[3]; if (dh > Math.PI) dh -= 2 * Math.PI; if (dh < -Math.PI) dh += 2 * Math.PI;
    return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, z: a[2] + (b[2] - a[2]) * f, h: a[3] + dh * f,
             steer: (a[4] ?? 0) + ((b[4] ?? 0) - (a[4] ?? 0)) * f, slip: (a[5] ?? 0) + ((b[5] ?? 0) - (a[5] ?? 0)) * f,
             vz: (b[2] - a[2]), dist: Math.hypot(b[0] - a[0], b[1] - a[1]), end: pos >= list.length - 1 };
  }
  function place(obj, st) {
    obj.position.set(st.x, st.z, -st.y);
    obj.rotation.y = yawOf(st.h);
    obj.rotation.x = -Math.atan2(st.vz, Math.max(0.05, st.dist)) * 0.8;
    for (const w of obj.userData.wheels) {
      w.mesh.rotation.x += st.dist / 0.34;                         // rueda que gira con la distancia recorrida
      w.mesh.rotation.y = w.front ? st.steer : 0;                  // ruedas delanteras con el ángulo REAL del volante
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
    camHeading += dh * (1 - Math.exp(-dt * 4));
    const h = camHeading;
    const dir = new THREE.Vector3(Math.cos(h), 0, -Math.sin(h)), left = new THREE.Vector3(-Math.sin(h), 0, -Math.cos(h));
    const desired = new THREE.Vector3(), look = car.position.clone();
    if (mode === 'follow') { desired.copy(car.position).addScaledVector(dir, -7.5).add(new THREE.Vector3(0, 2.6, 0)); look.addScaledVector(dir, 10).y += 0.9; }
    else if (mode === 'side') { desired.copy(car.position).addScaledVector(left, 20).addScaledVector(dir, -3).add(new THREE.Vector3(0, 7, 0)); look.addScaledVector(dir, 4); }
    else { desired.set(0, 430, 0.01); look.set(0, 0, 0); }
    const k = 1 - Math.exp(-dt * (mode === 'top' ? 2 : mode === 'side' ? 5 : 8));
    camPos.lerp(desired, k); camLook.lerp(look, k); camera.position.copy(camPos); camera.lookAt(camLook);
  }

  function resize() { camera.aspect = host.clientWidth / Math.max(1, host.clientHeight); camera.updateProjectionMatrix(); renderer.setSize(host.clientWidth, host.clientHeight); }
  new ResizeObserver(resize).observe(host); resize();
  receive(window.rallyV5Scenario);
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
      window.dispatchEvent(new CustomEvent('rally5:tick', { detail: { frame, end: st.end } }));
      updateCamera(dt, st);
    }
    renderer.render(scene, camera);
  });
  world.classList.add('has-3d'); tools.hidden = false;
  window.rallyV5Scene = { setMode, camera, renderer, scene };
} catch (error) {
  host.replaceChildren(); world.classList.remove('has-3d'); tools.hidden = true;
  message.hidden = false; message.textContent = 'Este navegador no pudo iniciar WebGL. La tabla y las curvas siguen disponibles.';
  console.error('Rally v5 3D:', error);
}
