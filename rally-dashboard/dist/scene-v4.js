import * as THREE from 'three';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { GLTFLoader } from './vendor/three/addons/loaders/GLTFLoader.js';

// Vista 3D del N4. Solo dibuja: la forma de la pista (track_samples), los obstáculos de cada
// pista (layout) y las posiciones del coche (poses x, y, altura, rumbo) vienen de Python.
// Conversión de coordenadas: Python (x, y, altura) -> Three.js (x, altura, -y).
const host = document.getElementById('scene3d');
const world = host.parentElement;
const message = document.getElementById('sceneStatus');
const tools = document.querySelector('.view-tools');
const data = window.rallyV4Data;
const cfg = data.config;
const LANES = cfg.track.lanes, W = cfg.track.lane_width_m, CELL = cfg.track.cell_m, HALF = LANES * W / 2;
const L = data.track_length;
const P = cfg.physics;
const RAMP_LEN = P.ramp_height_m / Math.tan(P.ramp_angle_deg * Math.PI / 180);
const samples = data.track_samples;           // [x, y, rumbo] cada 2 m
const STEP = 2;
const COLORS = Object.fromEntries(Object.entries(cfg.terrains).map(([k, v]) => [v.code, v.color]));

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
const yawOf = heading => Math.PI / 2 - heading;  // rumbo de Python -> rotación de un modelo que mira a +z
const laneD = lane => ((LANES - 1) / 2 - lane) * W;

try {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  host.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.setAttribute('aria-label', 'Pista 3D del experimento 4 dentro de un estadio');

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#9fd3f2');
  scene.fog = new THREE.Fog('#9fd3f2', 350, 1100);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 3000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.maxPolarAngle = Math.PI / 2 - 0.05; controls.enabled = false;
  scene.add(new THREE.HemisphereLight('#ffffff', '#5d7f33', 2.0));
  const sun = new THREE.DirectionalLight('#fff3dc', 3.0);
  sun.position.set(-120, 260, 160); sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -300, right: 300, top: 160, bottom: -160, near: 1, far: 700 });
  sun.shadow.normalBias = 0.05;
  scene.add(sun);

  const mats = {};
  const mat = (color, o = {}) => (mats[color + JSON.stringify(o)] ??= new THREE.MeshStandardMaterial({ color, roughness: 0.85, side: THREE.DoubleSide, ...o }));

  // Banda que sigue la pista (piso, manchas de terreno, rampas, losas del puente).
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

  // Suelo, pista base y bordillos (fijos).
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), mat('#7fb83a'));
  grass.rotation.x = -Math.PI / 2; grass.position.y = -0.35; grass.receiveShadow = true; scene.add(grass);
  scene.add(band({ s0: 0, s1: L, d: 0, width: 2 * HALF + 0.6, top: 0.0, bottom: -0.3, material: mat(COLORS['.']), steps: 700 }));
  for (const side of [-1, 1]) for (let s = 0; s < L; s += 4) {
    scene.add(band({ s0: s, s1: s + 2, d: side * (HALF + 0.6), width: 1.2, top: 0.12, bottom: -0.2, material: mat(((s / 4) % 2) ? '#f4f1e8' : '#d8332a'), steps: 1 }));
  }
  for (let k = 1; k < LANES; k++) for (let s = 0; s < L; s += 6) {
    scene.add(band({ s0: s, s1: s + 2.5, d: laneD(k - 0.5), width: 0.18, top: 0.03, bottom: -0.1, material: mat('#f4efe6'), steps: 1 }));
  }

  // ---------- modelos 3D ----------
  const loader = new GLTFLoader();
  const load = url => loader.loadAsync(url).then(g => g.scene).catch(err => { console.warn('No cargó', url, err); return null; });
  const models = {};
  const ready = Promise.all([load('models3d/estadio.glb'), load('models3d/coche.glb'), load('models3d/valla.glb'), load('models3d/piezas-pista.glb')])
    .then(([estadio, coche, valla, piezas]) => { Object.assign(models, { estadio, coche, valla, piezas }); });

  function prepCar(src, opacity = 1) {
    const g = new THREE.Group();
    const car = src.clone(true);
    car.scale.setScalar(0.01);                               // el modelo viene en centímetros
    const box = new THREE.Box3().setFromObject(car), c = box.getCenter(new THREE.Vector3());
    car.position.set(-c.x, -box.min.y, -c.z);
    const wheels = [];
    car.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = true;
      if (opacity < 1) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = opacity; o.material.depthWrite = false; }
      if (/Wheel/.test(o.name)) {
        o.geometry = o.geometry.clone(); o.geometry.computeBoundingBox();
        const wc = o.geometry.boundingBox.getCenter(new THREE.Vector3());
        o.geometry.translate(-wc.x, -wc.y, -wc.z); o.position.add(wc); wheels.push(o);
      }
    });
    g.add(car); g.userData.wheels = wheels; g.rotation.order = 'YXZ';
    return g;
  }
  function fallbackCar(color) {
    const g = new THREE.Group();
    const b = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.9, 4.4), mat(color, { roughness: 0.3 })); b.position.y = 0.7; b.castShadow = true; g.add(b);
    g.userData.wheels = []; g.rotation.order = 'YXZ'; return g;
  }

  // ---------- obstáculos de la pista actual ----------
  let layoutGroup = null, layoutKey = null;
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
        if (code === 'L' || code === 'S') add(band({ s0, s1, d, width: W * 0.96, top: 0.05, material: mat(COLORS[code]) }));
        if (code === 'L') for (let i = 0; i < 4; i++) {
          const bump = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6), mat('#4a2f1c'));
          bump.position.copy(at(s0 + 1.5 + i * 2.3, d + (i % 2 ? 0.8 : -0.8), 0.05)); bump.scale.set(1.1, 0.2, 1.1); add(bump);
        }
        if (code === 'A') add(band({ s0: s0 + 0.3, s1: s1 - 0.3, d, width: W * 0.9, top: 0.06, material: mat(COLORS.A, { roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.85 }) }));
        if (code === 'F') {
          add(band({ s0, s1, d, width: W, top: 0.02, bottom: -0.25, material: mat('#0b0806') }));
          for (const side of [-1, 1]) add(band({ s0, s1, d: d + side * (W / 2 - 0.15), width: 0.3, top: 0.25, material: mat('#ffcf33') }));
        }
        if (code === 'R') {
          const start = s1 - RAMP_LEN;
          add(band({ s0: start, s1, d, width: W * 0.96, top: f => P.ramp_height_m * f, bottom: 0, material: mat(COLORS.R), steps: 6 }));
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
    // Puente: losas a 3 m, pilares, hueco y bajada.
    layout.deck.forEach((row, lane) => {
      const d = laneD(lane), H = P.deck_height_m, gap = cfg.config_gap ?? 6;
      for (let c = 0; c < row.length; c++) {
        const code = row[c], s0 = c * CELL, s1 = s0 + CELL;
        if (code === 'P') add(band({ s0, s1, d, width: W, top: H, bottom: H - 0.45, material: mat('#f2b48b') }));
        if (code === 'G') {
          const a = (CELL - 6) / 2;
          add(band({ s0, s1: s0 + a, d, width: W, top: H, bottom: H - 0.45, material: mat('#f2b48b') }));
          add(band({ s0: s1 - a, s1, d, width: W, top: H, bottom: H - 0.45, material: mat('#f2b48b') }));
        }
        if (code === 'D') add(band({ s0, s1, d, width: W, top: f => H * (1 - f), bottom: f => Math.max(0, H * (1 - f) - 0.45), material: mat('#e8a983'), steps: 6 }));
        if (code === 'P' || code === 'G') {
          for (const side of [-1, 1]) {
            const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.6, H - 0.45, 0.6), mat('#f6c9ae'));
            pillar.position.copy(at(s0 + CELL / 2, d + side * (W / 2 - 0.4), (H - 0.45) / 2)); pillar.castShadow = true; add(pillar);
          }
          for (const side of [-1, 1]) add(band({ s0, s1, d: d + side * (W / 2 - 0.08), width: 0.16, top: H + 0.5, bottom: H, material: mat('#ffffff') }));
        }
      }
    });
    scene.add(layoutGroup);
  }

  // Asfalto de salida con las piezas de Kay Lousberg (losas de 2 m escaladas a un carril de 4 m).
  function buildStart() {
    if (!models.piezas) return;
    const pick = name => { let n = null; models.piezas.traverse(o => { if (o.name === name) n = o; }); return n; };
    const straight = pick('road_straight'), crossing = pick('road_straight_crossing');
    if (!straight || !crossing) return;
    for (let lane = 0; lane < LANES; lane++) for (let k = 0; k < 6; k++) {
      const src = k === 0 ? crossing : straight;
      const tile = src.clone(true); tile.position.set(0, 0, 0);
      const box = new THREE.Box3().setFromObject(tile), c = box.getCenter(new THREE.Vector3());
      const holder = new THREE.Group(); tile.position.sub(c); holder.add(tile);
      holder.scale.set(2, 1, 2);
      const s = 2 + k * 4;
      holder.position.copy(at(s, laneD(lane), 0.04)); holder.rotation.y = yawOf(center(s)[2]) + (k === 0 ? 0 : Math.PI / 2);
      holder.traverse(o => { if (o.isMesh) o.receiveShadow = true; });
      scene.add(holder);
    }
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
      if (/^Box007_1_(5|6|7|8|9|10|11)$/.test(o.name)) o.visible = false;   // arcos de fútbol de la cancha
    });
    st.updateMatrixWorld(true);
    const pb = new THREE.Box3().setFromObject(pitch ?? st), pc = pb.getCenter(new THREE.Vector3()), ps = pb.getSize(new THREE.Vector3());
    if (pitch) pitch.visible = false;           // la cancha de fútbol se reemplaza por la pista
    if (base) base.visible = false;             // la base verde del modelo queda bajo el pasto
    const holder = new THREE.Group(); st.position.set(-pc.x, -pb.min.y, -pc.z); holder.add(st);
    holder.rotation.y = Math.PI / 2;            // el lado largo de la cancha queda a lo largo de las rectas
    const halfX = cfg.track.straight_m / 2 + cfg.track.radius_m + HALF + 8, halfZ = cfg.track.radius_m + HALF + 8;
    holder.scale.set(halfZ / (ps.x / 2), 1.8, halfX / (ps.z / 2));
    holder.traverse(o => { if (o.isMesh) o.receiveShadow = true; });
    scene.add(holder);
  }
  const startGate = new THREE.Group(); {
    const banner = new THREE.Mesh(new THREE.BoxGeometry(2 * HALF + 2, 1.4, 0.3), mat('#111111')); banner.position.y = 6; startGate.add(banner);
    for (const x of [-(HALF + 1), HALF + 1]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, 6.7, 0.4), mat('#222222')); post.position.set(x, 3.3, 0); startGate.add(post); }
    startGate.position.copy(at(0.5, 0, 0)); startGate.rotation.y = yawOf(center(0.5)[2]) + Math.PI / 2; scene.add(startGate);
  }

  // ---------- coches ----------
  let car = fallbackCar('#ffc320'), ghost = fallbackCar('#5a8ee8');
  ghost.visible = false; scene.add(car); scene.add(ghost);
  ready.then(() => {
    buildStadium(); buildStart();
    if (models.coche) {
      scene.remove(car); scene.remove(ghost);
      car = prepCar(models.coche); ghost = prepCar(models.coche, 0.45); ghost.visible = false;
      ghost.traverse(o => { if (o.isMesh && !/Wheel|Glass/.test(o.name)) { o.material.color = new THREE.Color('#5a8ee8'); } });
      scene.add(car); scene.add(ghost);
    }
    if (current) { layoutKey = null; buildLayout(current.layout); }
    message.hidden = true;
  });

  // ---------- reproducción ----------
  let current = null, playStart = 0, stepMs = 250, paused = false, pausedAt = 0;
  function posesOf(frames) {   // lista de [x, y, z, rumbo] cada 0,05 s
    const out = [frames[0].poses[frames[0].poses.length - 1]];
    for (let i = 1; i < frames.length; i++) out.push(...frames[i].poses);
    return out;
  }
  function receive(d) {
    if (!d) return;
    if (d.layout && (!current || current.layout.seed !== d.layout.seed)) buildLayout(d.layout);
    current = { ...d, poses: posesOf(d.frames), ghostPoses: d.ghost ? posesOf(d.ghost.frames) : null };
    ghost.visible = !!d.ghost;
    stepMs = d.stepMs; playStart = performance.now() - (d.frameIndex * stepMs); paused = d.paused; pausedAt = d.frameIndex * stepMs;
  }
  window.addEventListener('rally4:scenario', e => receive(e.detail));
  window.addEventListener('rally4:control', e => {
    const c = e.detail;
    if ('stepMs' in c) { const t = elapsed(); stepMs = c.stepMs; playStart = performance.now() - t / 1 * 1; }
    if ('paused' in c) { if (c.paused) { pausedAt = elapsed(); paused = true; } else { paused = false; playStart = performance.now() - pausedAt; } }
    if ('seekFrame' in c) { pausedAt = c.seekFrame * stepMs; playStart = performance.now() - pausedAt; }
  });
  function elapsed() { return paused ? pausedAt : performance.now() - playStart; }
  const SUB = P.substeps;
  function sample(poses, t) {
    const pos = t / stepMs * SUB;
    const i = Math.min(poses.length - 2, Math.max(0, Math.floor(pos))), f = Math.min(1, Math.max(0, pos - i));
    const a = poses[i], b = poses[i + 1] ?? a;
    let dh = b[3] - a[3]; if (dh > Math.PI) dh -= 2 * Math.PI; if (dh < -Math.PI) dh += 2 * Math.PI;
    return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, z: a[2] + (b[2] - a[2]) * f, h: a[3] + dh * f, vz: (b[2] - a[2]), dist: Math.hypot(b[0] - a[0], b[1] - a[1]), end: pos >= poses.length - 1 };
  }
  function place(obj, st) {
    obj.position.set(st.x, st.z, -st.y);
    obj.rotation.y = yawOf(st.h);
    obj.rotation.x = -Math.atan2(st.vz, Math.max(0.05, st.dist)) * 0.8;
    for (const w of obj.userData.wheels) w.rotation.x += st.dist / 0.34;
  }

  // ---------- cámaras (iguales a v3: punto ideal + suavizado) ----------
  let mode = 'follow';
  const camPos = new THREE.Vector3(0, 120, 260), camLook = new THREE.Vector3();
  function setMode(m) {
    mode = m; controls.enabled = m === 'free';
    for (const b of tools.querySelectorAll('button[data-cam]')) b.setAttribute('aria-pressed', String(b.dataset.cam === m));
    if (m === 'free') { controls.target.copy(car.position); camera.position.set(car.position.x + 40, 40, car.position.z + 60); }
  }
  for (const b of tools.querySelectorAll('button[data-cam]')) b.onclick = () => setMode(b.dataset.cam);
  function updateCamera(dt, h) {
    if (mode === 'free') { controls.update(); return; }
    const dir = new THREE.Vector3(Math.cos(h), 0, -Math.sin(h)), left = new THREE.Vector3(-Math.sin(h), 0, -Math.cos(h));
    const desired = new THREE.Vector3(), look = car.position.clone();
    if (mode === 'follow') { desired.copy(car.position).addScaledVector(dir, -8.5).add(new THREE.Vector3(0, 3.4, 0)); look.addScaledVector(dir, 9).y += 1; }
    else if (mode === 'side') { desired.copy(car.position).addScaledVector(left, 22).addScaledVector(dir, -3).add(new THREE.Vector3(0, 8, 0)); look.addScaledVector(dir, 4); }
    else { desired.set(0, 420, 0.01); look.set(0, 0, 0); }
    const k = 1 - Math.exp(-dt * (mode === 'top' ? 2 : mode === 'side' ? 5 : 7));
    camPos.lerp(desired, k); camLook.lerp(look, k); camera.position.copy(camPos); camera.lookAt(camLook);
  }

  function resize() { camera.aspect = host.clientWidth / Math.max(1, host.clientHeight); camera.updateProjectionMatrix(); renderer.setSize(host.clientWidth, host.clientHeight); }
  new ResizeObserver(resize).observe(host); resize();
  receive(window.rallyV4Scenario);
  setMode('follow');
  let last = performance.now();
  renderer.setAnimationLoop(now => {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (current) {
      const t = elapsed();
      const st = sample(current.poses, t); place(car, st);
      if (current.ghostPoses) place(ghost, sample(current.ghostPoses, t));
      window.dispatchEvent(new CustomEvent('rally4:tick', { detail: { frame: Math.min(current.frames.length - 1, Math.floor(t / stepMs) + 1), end: st.end } }));
      updateCamera(dt, st.h);
    }
    renderer.render(scene, camera);
  });
  world.classList.add('has-3d'); tools.hidden = false;
  window.rallyV4Scene = { setMode, camera };
} catch (error) {
  host.replaceChildren(); world.classList.remove('has-3d'); tools.hidden = true;
  message.hidden = false; message.textContent = 'Este navegador no pudo iniciar WebGL. La tabla y las curvas siguen disponibles.';
  console.error('Rally v4 3D:', error);
}
