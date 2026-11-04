import * as THREE from 'three';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { makeTrack, TERRAIN_COLORS } from './track-v3.js';

// Vista 3D del experimento 3. SOLO presentación: dibuja la pista que viene del JSON
// de Python y mueve el coche a las posiciones que Python registró. No decide nada.
const host = document.getElementById('scene3d');
const world = host.parentElement;
const message = document.getElementById('sceneStatus');
const tools = document.querySelector('.view-tools');

const env = window.rallyV3Config.environment;
const N = env.track_length_meters / env.segment_meters;        // 30 tramos
const terrainByCode = Object.fromEntries(env.terrains.map(t => [t.code, t]));
const track = makeTrack({ lanes: env.lanes });
const CELL = track.perimeter / N;                              // largo de un tramo en la escena
const RAMP_TOP = 2.4;   // altura de la punta de la rampa
const DECK_H = 2.8;     // altura del puente (plataforma suspendida)
const RAMP_PEAK = 0.8;  // la rampa sube en el 80% del tramo y cae en el 20% final
let layout = window.rallyV3Layout;

const uOf = s => THREE.MathUtils.clamp(s, 0, N) / N;
const rampProfile = t => (t < RAMP_PEAK ? RAMP_TOP * t / RAMP_PEAK : RAMP_TOP * (1 - t) / (1 - RAMP_PEAK));

// Altura del suelo en un punto (tramo continuo s, carril): solo las rampas levantan el suelo.
function groundHeight(s, lane) {
  const i = Math.floor(s);
  if (i < 0 || i >= N) return 0;
  const t = terrainByCode[layout[lane].ground[i]];
  return t.kind === 'ramp' ? rampProfile(s - i) : 0;
}

try {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  host.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.setAttribute('aria-label', 'Pista 3D de cuatro carriles con rampas, puente elevado, lodo, agua y barriles');

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#9fd3f2');
  scene.fog = new THREE.Fog('#9fd3f2', 180, 420);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 900);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2 - 0.05;
  controls.minDistance = 8;
  controls.maxDistance = 320;
  controls.enabled = false;

  scene.add(new THREE.HemisphereLight('#ffffff', '#6d8f3a', 2.2));
  const sun = new THREE.DirectionalLight('#fff4dc', 3.2);
  sun.position.set(-60, 120, 70);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -120, right: 120, top: 90, bottom: -90, near: 1, far: 320 });
  sun.shadow.normalBias = 0.04;
  scene.add(sun);

  const mats = {};
  const mat = (color, opts = {}) => (mats[color + JSON.stringify(opts)] ??= new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...opts }));

  // ---------- Geometría a lo largo de la pista ----------
  // "strip" construye un bloque que sigue la curva del carril: una cara superior cuya
  // altura la decide topFn, dos paredes laterales y dos tapas. Con esto se hacen
  // el piso, las manchas de lodo/agua, las rampas (cuña) y el puente (losa elevada).
  function strip({ lane, s0, s1, top, bottom = 0, width = track.W * 0.97, material, steps }) {
    steps ??= Math.max(3, Math.ceil((s1 - s0) * 12));
    const off = track.laneOffset(lane), half = width / 2;
    const topFn = typeof top === 'function' ? top : () => top;
    const botFn = typeof bottom === 'function' ? bottom : () => bottom;
    const pos = [], idx = [];
    for (let i = 0; i <= steps; i++) {
      const f = i / steps, p = track.pointAt(uOf(s0 + (s1 - s0) * f), 0);
      const ht = topFn(f), hb = botFn(f);
      for (const [o, h] of [[off - half, ht], [off + half, ht], [off - half, hb], [off + half, hb]]) {
        pos.push(p.x + p.nx * o, h, p.z + p.nz * o);
      }
      if (i < steps) {
        const k = i * 4;
        idx.push(k, k + 4, k + 1, k + 1, k + 4, k + 5);        // superior
        idx.push(k, k + 2, k + 4, k + 4, k + 2, k + 6);        // pared interior
        idx.push(k + 1, k + 5, k + 3, k + 3, k + 5, k + 7);    // pared exterior
      }
    }
    const e = steps * 4;
    idx.push(0, 1, 2, 2, 1, 3, e, e + 2, e + 1, e + 1, e + 2, e + 3); // tapas
    let g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g = g.toNonIndexed();
    g.computeVertexNormals();
    material.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(g, material);
    mesh.castShadow = mesh.receiveShadow = true;
    return mesh;
  }
  const along = (s, lane, h = 0) => {
    const p = track.pointAt(uOf(s), track.laneOffset(lane));
    return { pos: new THREE.Vector3(p.x, h, p.z), yaw: Math.atan2(p.dx, p.dz) };
  };
  function barrel(parent, s, lane, h = 0) {
    const g = new THREE.Group(), { pos, yaw } = along(s, lane, h);
    g.position.copy(pos); g.rotation.y = yaw;
    for (const x of [-0.9, 0.9]) {
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 1.5, 18), mat('#d8332a', { roughness: 0.5 }));
      body.position.set(x, 0.75, 0); body.castShadow = true; g.add(body);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.64, 0.64, 0.25, 18), mat('#f4f1e8'));
      band.position.set(x, 0.85, 0); g.add(band);
    }
    parent.add(g);
  }
  function mudBumps(parent, s, lane) {
    for (let i = 0; i < 4; i++) {
      const bump = new THREE.Mesh(new THREE.SphereGeometry(0.9, 10, 6), mat('#4a2f1c'));
      const { pos } = along(s + 0.15 + i * 0.22, lane + (i % 2 ? 0.18 : -0.18), 0.05);
      bump.position.copy(pos); bump.scale.set(1.2, 0.22, 1.2); bump.receiveShadow = true;
      parent.add(bump);
    }
  }

  // ---------- Construcción de la pista (se rehace si cambia el clima) ----------
  let trackGroup = null;
  function buildTrack() {
    if (trackGroup) { scene.remove(trackGroup); trackGroup.traverse(o => o.geometry?.dispose()); }
    trackGroup = new THREE.Group();
    const add = m => (trackGroup.add(m), m);
    const fullWidth = track.W * env.lanes + 1.2;
    add(strip({ lane: (env.lanes - 1) / 2, s0: 0, s1: N, top: 0.03, bottom: -0.25, width: fullWidth, material: mat(TERRAIN_COLORS.asfalto), steps: 900 }));
    layout.forEach((row, lane) => {
      for (let i = 0; i < N; i++) {
        const t = terrainByCode[row.ground[i]];
        const color = TERRAIN_COLORS[t.name];
        if (t.name === 'lodo') { add(strip({ lane, s0: i, s1: i + 1, top: 0.07, material: mat(color) })); mudBumps(trackGroup, i, lane); }
        if (t.name === 'agua') add(strip({ lane, s0: i + 0.02, s1: i + 0.98, top: 0.08, width: track.W * 0.9, material: mat(color, { roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.85 }) }));
        if (t.name === 'sin_pista') add(strip({ lane, s0: i, s1: i + 1, top: 0.06, material: mat(color) }));
        if (t.name === 'foso') add(strip({ lane, s0: i, s1: i + 1, top: 0.065, material: mat(color) }));
        if (t.name === 'barril') barrel(trackGroup, i + 0.5, lane);
        if (t.kind === 'ramp') {
          // Rampa = cuña: el techo sube de 0 a RAMP_TOP y cae al final del tramo.
          add(strip({ lane, s0: i, s1: i + 1, top: f => rampProfile(f), material: mat(TERRAIN_COLORS.rampa) }));
          for (let k = 1; k < 4; k++) add(strip({ lane, s0: i + k * 0.18, s1: i + k * 0.18 + 0.03, top: f => rampProfile(k * 0.18 + 0.03 * f) + 0.02, width: track.W * 0.97, material: mat('#f2b48b') }));
          if (t.barrel_on_ramp) barrel(trackGroup, i + 0.5, lane, rampProfile(0.5));
        }
        const deck = row.deck[i];
        if (deck === 'P') {
          // Plataforma suspendida = losa a DECK_H con pilares hasta el piso.
          add(strip({ lane, s0: i, s1: i + 1, top: DECK_H, bottom: DECK_H - 0.5, material: mat(TERRAIN_COLORS.puente) }));
          const { pos, yaw } = along(i + 0.5, lane);
          const pillar = new THREE.Mesh(new THREE.BoxGeometry(track.W * 0.6, DECK_H - 0.5, 1.2), mat('#f6c9ae'));
          pillar.position.set(pos.x, (DECK_H - 0.5) / 2, pos.z); pillar.rotation.y = yaw;
          pillar.castShadow = pillar.receiveShadow = true; trackGroup.add(pillar);
        }
      }
    });
    // Líneas blancas discontinuas entre carriles.
    for (let k = 1; k < env.lanes; k++) {
      const offLane = k - 0.5;
      for (let d = 0; d < N * 3; d++) add(strip({ lane: offLane, s0: d / 3, s1: d / 3 + 0.12, top: 0.09, width: 0.22, material: mat('#f4efe6'), steps: 2 }));
    }
    // Salida / meta a cuadros.
    for (let x = 0; x < 14; x++) for (let z = 0; z < 2; z++) {
      add(strip({ lane: (env.lanes - 1) / 2 + (x - 6.5) * fullWidth / 14 / track.W, s0: z * 0.04, s1: z * 0.04 + 0.04, top: 0.1, width: fullWidth / 14, material: mat((x + z) % 2 ? '#111111' : '#ffffff'), steps: 1 }));
    }
    scene.add(trackGroup);
  }

  // ---------- Decorado fijo: pasto, fardos, muro azul, público ----------
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), mat('#8cc63f'));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.3; ground.receiveShadow = true; scene.add(ground);
  const edge = track.W * env.lanes / 2 + 1.2;
  const bales = new THREE.InstancedMesh(new THREE.BoxGeometry(1.4, 1, 1.4), mat('#f2a98a'), 400);
  let b = 0;
  const dummy = new THREE.Object3D();
  for (let a = 0; a < track.perimeter && b < 398; a += 2.3) {
    for (const side of [-1, 1]) {
      const p = track.pointAt(a / track.perimeter, side * edge);
      dummy.position.set(p.x, 0.25, p.z); dummy.rotation.set(0, Math.atan2(p.dx, p.dz), 0); dummy.updateMatrix();
      bales.setMatrixAt(b++, dummy.matrix);
    }
  }
  bales.count = b; bales.castShadow = true; scene.add(bales);
  const crowdColors = ['#f08a5d', '#5a8ee8', '#ffffff', '#f2c14e', '#e85d75', '#7dd3c0'].map(c => new THREE.Color(c));
  const crowd = new THREE.InstancedMesh(new THREE.BoxGeometry(0.8, 1.1, 0.6), new THREE.MeshStandardMaterial({ roughness: 0.9 }), 4000);
  let c = 0;
  for (const side of [-1, 1]) {
    const zWall = side * (track.R + edge + 3);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(track.S + 10, 2, 0.6), mat('#4f7fd9'));
    wall.position.set(0, 0.7, zWall); wall.castShadow = true; scene.add(wall);
    for (let row = 0; row < 8; row++) {
      const z = zWall + side * (2 + row * 1.6), h = 1 + row * 1.1;
      const step = new THREE.Mesh(new THREE.BoxGeometry(track.S + 10, h, 1.6), mat(row % 2 ? '#d9d3c7' : '#c8c1b4'));
      step.position.set(0, h / 2 - 0.3, z); step.receiveShadow = true; scene.add(step);
      for (let x = -track.S / 2; x < track.S / 2 && c < 3990; x += 1.15) {
        if (Math.random() < 0.15) continue;
        dummy.position.set(x + Math.random() * 0.3, h + 0.25, z); dummy.rotation.set(0, side > 0 ? Math.PI : 0, 0); dummy.updateMatrix();
        crowd.setMatrixAt(c, dummy.matrix); crowd.setColorAt(c, crowdColors[c % crowdColors.length]); c++;
      }
    }
  }
  crowd.count = c; scene.add(crowd);
  // Carteles con el nombre de cada carril, junto a la salida.
  function label(text, w, color, bg) {
    const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 160;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = bg; ctx.fillRect(0, 0, 1024, 160);
    ctx.font = '800 72px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = color; ctx.fillText(text, 512, 82);
    const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace;
    return new THREE.Mesh(new THREE.PlaneGeometry(w, w * 160 / 1024), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
  }
  const banner = label('AUTONOMOUS RALLY LAB · N3', 40, '#ffffff', '#4f7fd9');
  banner.position.set(0, 3.2, -(track.R + edge + 2.6)); scene.add(banner);
  const startGate = label('SALIDA / META', 18, '#111', '#ffd12e');
  { const p = track.pointAt(0, 0); startGate.position.set(p.x, 6.2, p.z); startGate.rotation.y = Math.atan2(p.dx, p.dz) + Math.PI / 2; scene.add(startGate);
    for (const side of [-1, 1]) { const q = track.pointAt(0, side * (edge - 0.4)); const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 6.6, 0.5), mat('#222')); post.position.set(q.x, 3, q.z); post.castShadow = true; scene.add(post); } }

  // ---------- El coche ----------
  const car = new THREE.Group(); car.rotation.order = 'YXZ'; scene.add(car);
  const body = new THREE.Group(); body.scale.setScalar(1.25); car.add(body);
  const box = (size, xyz, m) => { const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), m); mesh.position.set(...xyz); mesh.castShadow = true; body.add(mesh); return mesh; };
  const yellow = mat('#ffc320', { roughness: 0.3, metalness: 0.35 }), glass = mat('#193a4a', { roughness: 0.18, metalness: 0.6 }), dark = mat('#17232c');
  box([1.48, 0.42, 2.9], [0, 0.58, 0], yellow);
  box([1.22, 0.52, 1.35], [0, 1.01, -0.1], glass);
  box([1.3, 0.12, 1.3], [0, 1.31, -0.14], yellow);
  box([1.65, 0.1, 0.35], [0, 1, -1.37], dark);
  const wheels = [];
  for (const x of [-0.8, 0.8]) for (const z of [-0.94, 0.94]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.23, 18), dark);
    w.rotation.z = Math.PI / 2; w.position.set(x, 0.4, z); w.castShadow = true; body.add(w); wheels.push(w);
  }

  // ---------- Animación de un paso ----------
  // Cada paso de Python trae: de dónde salió, a dónde llegó, si saltó y si chocó.
  // Aquí se arma un recorrido de "puntos de paso" y se interpola entre ellos.
  let legs = [], started = 0, duration = 1, lastKey = null, shownS = 0.5;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const centerS = seg => Math.min(seg + 0.5, N);

  function heightOf(s, lane, layer) { return layer ? DECK_H : groundHeight(s, Math.round(lane)); }

  function plan(d) {
    const from = { s: centerS(d.from.segment), lane: d.from.lane, layer: d.from.layer };
    const to = { s: d.to.segment >= N ? N : centerS(d.to.segment), lane: d.to.lane, layer: d.to.layer };
    const out = [];
    if (d.jump) {
      const lift = { s: d.jump.from_segment + RAMP_PEAK, lane: to.lane, layer: 0 };
      out.push({ a: from, b: lift, kind: 'ground' });
      out.push({ a: lift, b: to, kind: 'flight', h0: RAMP_TOP, h1: to.s >= N ? 0 : heightOf(to.s, to.lane, to.layer), peak: 1.5 + d.jump.flight * 1.2 });
    } else if (d.crash_segment !== null && d.crash_segment !== undefined && d.crash_segment !== d.to.segment) {
      const hit = { s: d.crash_segment + 0.25, lane: to.lane, layer: from.layer };
      out.push({ a: from, b: hit, kind: 'ground' });
      out.push({ a: hit, b: to, kind: 'bounce' });
    } else {
      out.push({ a: from, b: to, kind: d.crash_segment !== null && d.crash_segment !== undefined ? 'fall' : 'ground' });
    }
    let total = 0;
    for (const leg of out) { leg.len = Math.max(0.15, Math.abs(leg.b.s - leg.a.s) + Math.abs(leg.b.lane - leg.a.lane) * 0.4); total += leg.len; }
    let acc = 0;
    for (const leg of out) { leg.t0 = acc / total; acc += leg.len; leg.t1 = acc / total; }
    return out;
  }

  function sample(f) {
    const leg = legs.find(l => f <= l.t1) ?? legs[legs.length - 1];
    const k = THREE.MathUtils.clamp((f - leg.t0) / Math.max(1e-6, leg.t1 - leg.t0), 0, 1);
    const s = THREE.MathUtils.lerp(leg.a.s, leg.b.s, k);
    const lane = THREE.MathUtils.lerp(leg.a.lane, leg.b.lane, Math.min(1, k * 2));
    let h, spin = 0;
    if (leg.kind === 'flight') h = THREE.MathUtils.lerp(leg.h0, leg.h1, k) + 4 * leg.peak * k * (1 - k);
    else if (leg.a.layer === leg.b.layer) h = heightOf(s, lane, leg.a.layer);
    else h = THREE.MathUtils.lerp(heightOf(s, lane, leg.a.layer), heightOf(s, lane, leg.b.layer), THREE.MathUtils.smoothstep(k, 0, 1));
    if (leg.kind === 'bounce' || leg.kind === 'fall') spin = Math.sin(k * Math.PI) * 0.9;
    return { s, lane, h, spin, kind: leg.kind };
  }

  function receive(d) {
    if (!d) return;
    if (d.layout && d.layout !== layout) { layout = d.layout; buildTrack(); }
    legs = plan(d);
    const fresh = d.key !== lastKey || d.step === 0;
    lastKey = d.key;
    started = performance.now();
    duration = fresh || reduced.matches ? 0 : Math.max(80, d.duration * 0.85);
  }
  window.addEventListener('rally3:frame', e => receive(e.detail));

  // ---------- Cámaras ----------
  // follow: detrás del coche · side: de lado, como Excitebike · top: aérea · free: con el mouse.
  let mode = 'follow';
  const camPos = new THREE.Vector3(0, 60, 120), camLook = new THREE.Vector3();
  function setMode(next) {
    mode = next;
    controls.enabled = mode === 'free';
    for (const btn of tools.querySelectorAll('button[data-cam]')) btn.setAttribute('aria-pressed', String(btn.dataset.cam === mode));
    if (mode === 'free') { controls.target.copy(car.position); camera.position.set(car.position.x + 40, 45, car.position.z + 60); }
  }
  for (const btn of tools.querySelectorAll('button[data-cam]')) btn.onclick = () => setMode(btn.dataset.cam);

  function updateCamera(dt, p, dir, normalIn) {
    if (mode === 'free') { controls.update(); return; }
    const desired = new THREE.Vector3(), look = car.position.clone();
    if (mode === 'follow') {
      desired.copy(car.position).addScaledVector(dir, -15).add(new THREE.Vector3(0, 7, 0));
      look.addScaledVector(dir, 8).y += 1;
    } else if (mode === 'side') {
      desired.copy(car.position).addScaledVector(normalIn, 24).addScaledVector(dir, -4).add(new THREE.Vector3(0, 11, 0));
      look.addScaledVector(dir, 4).addScaledVector(normalIn, -3);
    } else {
      desired.set(0, 230, 0.01); look.set(0, 0, 0);
    }
    // Suavizado exponencial: la cámara "persigue" el punto deseado sin dar saltos.
    const k = 1 - Math.exp(-dt * (mode === 'top' ? 2 : mode === 'side' ? 5 : 3.5));
    camPos.lerp(desired, k); camLook.lerp(look, k);
    camera.position.copy(camPos); camera.lookAt(camLook);
  }

  function resize() { camera.aspect = host.clientWidth / Math.max(1, host.clientHeight); camera.updateProjectionMatrix(); renderer.setSize(host.clientWidth, host.clientHeight); }
  new ResizeObserver(resize).observe(host);
  resize();
  buildTrack();
  receive(window.rallyV3Frame);
  setMode('follow');

  let lastNow = performance.now();
  renderer.setAnimationLoop(now => {
    const dt = Math.min(0.1, (now - lastNow) / 1000); lastNow = now;
    if (!legs.length) { renderer.render(scene, camera); return; }
    const f = duration ? Math.min(1, (now - started) / duration) : 1;
    const st = sample(f);
    const off = track.laneOffset(st.lane), p = track.pointAt(uOf(st.s), off);
    const ahead = sample(Math.min(1, f + 0.01));
    const slope = (ahead.h - st.h) / Math.max(0.02, (ahead.s - st.s) * CELL);
    car.position.set(p.x, st.h + 0.05, p.z);
    car.rotation.y = Math.atan2(p.dx, p.dz) + st.spin;
    car.rotation.x = st.kind === 'flight' || Math.abs(slope) < 3 ? -Math.atan(THREE.MathUtils.clamp(slope, -1.2, 1.2)) * 0.8 : 0;
    for (const w of wheels) w.rotation.x += (st.s - shownS) * CELL / 0.45;
    shownS = st.s;
    const dir = new THREE.Vector3(p.dx, 0, p.dz), normalIn = new THREE.Vector3(p.nx, 0, p.nz);
    updateCamera(dt, p, dir, normalIn);
    renderer.render(scene, camera);
  });

  renderer.domElement.addEventListener('webglcontextlost', e => {
    e.preventDefault(); renderer.setAnimationLoop(null);
    world.classList.remove('has-3d'); tools.hidden = true; message.hidden = false;
    message.textContent = 'Se perdió la vista 3D. El mapa 2D de abajo sigue mostrando la carrera.';
  });
  world.classList.add('has-3d'); message.hidden = true; tools.hidden = false;
  window.rallyV3Scene = { setMode, camera, car };
} catch (error) {
  host.replaceChildren(); world.classList.remove('has-3d'); tools.hidden = true;
  message.hidden = false; message.textContent = 'Este navegador no pudo iniciar WebGL. El mapa 2D de abajo muestra la carrera.';
  console.error('Rally v3 3D:', error);
}
