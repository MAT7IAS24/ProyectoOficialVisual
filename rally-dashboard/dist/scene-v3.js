import * as THREE from 'three';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { makeTrack, TERRAIN_COLORS, TERRAIN_COLORS_V4 } from './track-v3.js';

// Renderer compartido de las escenas v3/v4. SOLO presentación: las reglas y
// las posiciones vienen de Python; el renderer no elige acciones ni hace física.
const host = document.getElementById('scene3d');
const world = host.parentElement;
const message = document.getElementById('sceneStatus');
const tools = document.querySelector('.view-tools');
const isV5 = window.rallySceneStyle === 'v5';
const isV4 = window.rallySceneStyle === 'v4' || isV5;
const levelLabel = isV5 ? 'N5' : 'N4';
const terrainColors = isV4 ? TERRAIN_COLORS_V4 : TERRAIN_COLORS;

const env = window.rallyV3Config.environment;
const N = env.track_length_meters / env.segment_meters;        // 30 tramos
const terrainByCode = Object.fromEntries(env.terrains.map(t => [t.code, t]));
const track = makeTrack({
  lanes: env.lanes,
  straight: isV5 ? 150 : 120,
  radius: isV5 ? 42 : 30,
  startOffset: isV5 ? 18 : 14,
});
const CELL = track.perimeter / N;                              // largo de un tramo en la escena
const RAMP_TOP = 2.4;   // altura de la punta de la rampa
const DECK_H = 2.8;     // altura del puente (plataforma suspendida)
const RAMP_PEAK = 0.8;  // la rampa sube en el 80% del tramo y cae en el 20% final
let layout = window.rallyV3Layout;
let weatherMode = 'normal';

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
  const drySky = new THREE.Color(isV4 ? '#b7d4e4' : '#9fd3f2');
  const rainSky = new THREE.Color('#71889a');
  scene.background = drySky.clone();
  scene.fog = new THREE.Fog(drySky, 180, 420);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 900);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2 - 0.05;
  controls.minDistance = 8;
  controls.maxDistance = 320;
  controls.enabled = false;

  const ambient = new THREE.HemisphereLight('#ffffff', isV4 ? '#53644e' : '#6d8f3a', isV4 ? 2.0 : 2.2);
  scene.add(ambient);
  const sun = new THREE.DirectionalLight(isV4 ? '#fff1d2' : '#fff4dc', isV4 ? 3.5 : 3.2);
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
    const roadMaterial = mat(terrainColors.asfalto, {
      roughness: isV4 && weatherMode === 'lluvia' ? 0.3 : isV4 ? 0.96 : 0.85,
      metalness: isV4 && weatherMode === 'lluvia' ? 0.16 : 0,
    });
    add(strip({ lane: (env.lanes - 1) / 2, s0: 0, s1: N, top: 0.03, bottom: -0.25, width: fullWidth, material: roadMaterial, steps: 900 }));
    layout.forEach((row, lane) => {
      for (let i = 0; i < N; i++) {
        const t = terrainByCode[row.ground[i]];
        const color = terrainColors[t.name];
        if (t.name === 'lodo') { add(strip({ lane, s0: i, s1: i + 1, top: 0.07, material: mat(color) })); mudBumps(trackGroup, i, lane); }
        if (t.name === 'agua') add(strip({ lane, s0: i + 0.02, s1: i + 0.98, top: 0.08, width: track.W * 0.9, material: mat(color, { roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.85 }) }));
        if (t.name === 'sin_pista') add(strip({ lane, s0: i, s1: i + 1, top: 0.06, material: mat(color) }));
        if (t.name === 'foso') add(strip({ lane, s0: i, s1: i + 1, top: 0.065, material: mat(color) }));
        if (t.name === 'barril') barrel(trackGroup, i + 0.5, lane);
        if (t.kind === 'ramp') {
          // Rampa = cuña: el techo sube de 0 a RAMP_TOP y cae al final del tramo.
          add(strip({ lane, s0: i, s1: i + 1, top: f => rampProfile(f), material: mat(terrainColors.rampa) }));
          for (let k = 1; k < 4; k++) add(strip({ lane, s0: i + k * 0.18, s1: i + k * 0.18 + 0.03, top: f => rampProfile(k * 0.18 + 0.03 * f) + 0.02, width: track.W * 0.97, material: mat('#f2b48b') }));
          if (t.barrel_on_ramp) barrel(trackGroup, i + 0.5, lane, rampProfile(0.5));
        }
        const deck = row.deck[i];
        if (deck === 'P') {
          // Plataforma suspendida = losa a DECK_H con pilares hasta el piso.
          add(strip({ lane, s0: i, s1: i + 1, top: DECK_H, bottom: DECK_H - 0.5, material: mat(terrainColors.puente) }));
          const { pos, yaw } = along(i + 0.5, lane);
          const pillar = new THREE.Mesh(new THREE.BoxGeometry(track.W * 0.6, DECK_H - 0.5, 1.2), mat('#f6c9ae'));
          pillar.position.set(pos.x, (DECK_H - 0.5) / 2, pos.z); pillar.rotation.y = yaw;
          pillar.castShadow = pillar.receiveShadow = true; trackGroup.add(pillar);
        }
      }
    });
    if (isV4) {
      const shoulder = mat('#929184', { roughness: 1 });
      add(strip({ lane: -0.9, s0: 0, s1: N, top: 0.045, width: 2, material: shoulder, steps: 900 }));
      add(strip({ lane: env.lanes - 0.1, s0: 0, s1: N, top: 0.045, width: 2, material: shoulder, steps: 900 }));
      for (let segment = 0; segment < N; segment++) {
        for (let offset = 0; offset < 1; offset += 0.5) {
          const color = Math.round(offset * 2 + segment) % 2 ? '#f5eee1' : '#dc5144';
          for (const side of [-1, 1]) {
            add(strip({
              lane: side < 0 ? -0.62 : env.lanes - 1 + 0.62,
              s0: segment + offset,
              s1: segment + offset + 0.5,
              top: 0.13,
              width: 0.72,
              material: mat(color, { roughness: 0.72 }),
              steps: 3,
            }));
          }
        }
      }
    }
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
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), mat(isV4 ? '#596c50' : '#8cc63f'));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.3; ground.receiveShadow = true; scene.add(ground);
  const edge = track.W * env.lanes / 2 + 1.2;
  const bales = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1.4, isV4 ? 0.78 : 1, isV4 ? 0.88 : 1.4),
    mat(isV4 ? '#f4eee3' : '#f2a98a'),
    400,
  );
  let b = 0;
  const dummy = new THREE.Object3D();
  for (let a = 0; a < track.perimeter && b < 398; a += 2.3) {
    for (const side of [-1, 1]) {
      const p = track.pointAt(a / track.perimeter, side * edge);
      dummy.position.set(p.x, isV4 ? 0.18 : 0.25, p.z);
      dummy.rotation.set(0, Math.atan2(p.dx, p.dz), 0);
      if (isV4) {
        dummy.scale.set(1, 1, 1);
        bales.setColorAt(b, new THREE.Color((b + Math.floor(a)) % 3 === 0 ? '#d94e43' : '#f4eee3'));
      }
      dummy.updateMatrix();
      bales.setMatrixAt(b++, dummy.matrix);
    }
  }
  bales.count = b; bales.castShadow = true; scene.add(bales);
  const crowdColors = ['#f08a5d', '#5a8ee8', '#ffffff', '#f2c14e', '#e85d75', '#7dd3c0'].map(c => new THREE.Color(c));
  const crowd = new THREE.InstancedMesh(new THREE.BoxGeometry(0.8, 1.1, 0.6), new THREE.MeshStandardMaterial({ roughness: 0.9 }), 4000);
  const visualRandom = seed => {
    const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return value - Math.floor(value);
  };
  let c = 0;
  const grandstandRows = isV5 ? 8 : isV4 ? 5 : 8;
  const grandstandSpacing = isV5 ? 0.85 : isV4 ? 1.15 : 1.6;
  const spectatorSpacing = isV5 ? 0.82 : isV4 ? 1.15 : 1.6;
  for (const side of [-1, 1]) {
    const zWall = side * (track.R + edge + 3);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(track.S + 10, 2, 0.6), mat(isV4 ? '#36546a' : '#4f7fd9'));
    wall.position.set(0, 0.7, zWall); wall.castShadow = true; scene.add(wall);
    for (let row = 0; row < grandstandRows; row++) {
      const z = zWall + side * (2 + row * grandstandSpacing);
      const h = isV4 ? 0.8 + row * 0.48 : 1 + row * 1.1;
      const step = new THREE.Mesh(
        new THREE.BoxGeometry(track.S + 10, h, grandstandSpacing),
        mat(isV4 ? (row % 2 ? '#697b7d' : '#84918a') : (row % 2 ? '#d9d3c7' : '#c8c1b4')),
      );
      step.position.set(0, h / 2 - 0.3, z); step.receiveShadow = true; scene.add(step);
      for (let x = -track.S / 2; x < track.S / 2 && c < 3990; x += spectatorSpacing) {
        const random = isV4 ? visualRandom(c + row * 401 + side * 197) : Math.random();
        if (random < 0.15) continue;
        const offset = isV4 ? visualRandom(c + 17) * 0.3 : Math.random() * 0.3;
        dummy.position.set(x + offset, h + 0.25, z); dummy.rotation.set(0, side > 0 ? Math.PI : 0, 0); dummy.updateMatrix();
        crowd.setMatrixAt(c, dummy.matrix); crowd.setColorAt(c, crowdColors[c % crowdColors.length]); c++;
      }
    }
    if (isV4) {
      const canopy = new THREE.Mesh(
        new THREE.BoxGeometry(track.S + 16, 0.32, 8),
        mat('#263b46', { metalness: 0.24, roughness: 0.62 }),
      );
      canopy.position.set(0, 4.5, side * (track.R + edge + 8.1));
      canopy.castShadow = canopy.receiveShadow = true;
      scene.add(canopy);
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
  const banner = label(
    isV4 ? `AUTONOMOUS RALLY LAB · ${levelLabel}` : 'AUTONOMOUS RALLY LAB · N3',
    isV4 ? 28 : 40,
    '#ffffff',
    isV4 ? '#1d3545' : '#4f7fd9',
  );
  banner.position.set(0, isV4 ? 4.1 : 3.2, -(track.R + edge + (isV4 ? 4 : 2.6)));
  scene.add(banner);
  if (!isV4) {
    const startGate = label('SALIDA / META', 18, '#111', '#ffd12e');
    const p = track.pointAt(0, 0);
    startGate.position.set(p.x, 6.2, p.z);
    startGate.rotation.y = Math.atan2(p.dx, p.dz) + Math.PI / 2;
    scene.add(startGate);
    for (const side of [-1, 1]) {
      const q = track.pointAt(0, side * (edge - 0.4));
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 6.6, 0.5), mat('#222'));
      post.position.set(q.x, 3, q.z);
      post.castShadow = true;
      scene.add(post);
    }
  }
  if (isV4) {
    const p = track.pointAt(0.45, 0);
    const gate = new THREE.Group();
    gate.position.set(p.x, 0, p.z);
    gate.rotation.y = Math.atan2(p.dx, p.dz);
    const beam = new THREE.Mesh(new THREE.BoxGeometry(19.2, 0.8, 0.9), mat('#1b2b35', { metalness: 0.4, roughness: 0.48 }));
    beam.position.set(0, 6.1, 0);
    beam.castShadow = true;
    gate.add(beam);
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.68, 6.1, 0.75), mat('#263640', { metalness: 0.28 }));
      post.position.set(side * 9.1, 3, 0);
      post.castShadow = true;
      gate.add(post);
      for (let lamp = 0; lamp < 3; lamp++) {
        const lens = new THREE.Mesh(
          new THREE.SphereGeometry(0.14, 12, 8),
          new THREE.MeshStandardMaterial({
            color: lamp === 2 ? '#44e28b' : '#f5e5bb',
            emissive: lamp === 2 ? '#1ca653' : '#b4a57b',
            emissiveIntensity: 1.4,
          }),
        );
        lens.position.set(side * 8.55, 5.55, 0.5 - lamp * 0.32);
        gate.add(lens);
      }
    }
    const wordmark = label(`RALLY · ${levelLabel}`, 10, '#f7f1df', '#263640');
    wordmark.position.set(0, 6.1, 0.48);
    gate.add(wordmark);
    scene.add(gate);
  }

  // ---------- El coche ----------
  const car = new THREE.Group(); car.rotation.order = 'YXZ'; scene.add(car);
  const body = new THREE.Group(); car.add(body);
  const box = (parent, size, xyz, material, rotation = [0, 0, 0]) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.position.set(...xyz);
    mesh.rotation.set(...rotation);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const yellow = mat(isV4 ? '#e5a92c' : '#ffc320', { roughness: 0.3, metalness: 0.35 });
  const glass = mat('#102532', { roughness: 0.2, metalness: 0.32 });
  const dark = mat(isV4 ? '#1a232a' : '#17232c', { roughness: 0.62, metalness: 0.18 });
  const wheels = [];
  const frontWheels = [];
  const brakeLights = [];
  let exhaustGlow = null;
  if (isV4) {
    const red = mat('#c73f36', { roughness: 0.42, metalness: 0.22 });
    const silver = mat('#b8c5c7', { roughness: 0.3, metalness: 0.78 });
    const tire = mat('#111518', { roughness: 0.94 });
    const brakeLamp = new THREE.MeshStandardMaterial({
      color: '#ff3f32', emissive: '#a8130d', emissiveIntensity: 0.45,
      roughness: 0.35,
    });
    const hullShape = new THREE.Shape();
    hullShape.moveTo(-0.77, 0.36);
    hullShape.lineTo(0.77, 0.36);
    hullShape.lineTo(0.94, 0.53);
    hullShape.lineTo(0.82, 0.99);
    hullShape.lineTo(0.67, 1.12);
    hullShape.lineTo(-0.67, 1.12);
    hullShape.lineTo(-0.82, 0.99);
    hullShape.lineTo(-0.94, 0.53);
    hullShape.closePath();
    const hullGeometry = new THREE.ExtrudeGeometry(hullShape, {
      depth: 2.7, bevelEnabled: true, bevelSegments: 3, bevelSize: 0.055,
      bevelThickness: 0.055, curveSegments: 3,
    });
    hullGeometry.translate(0, 0, -1.35);
    const hull = new THREE.Mesh(hullGeometry, yellow);
    hull.castShadow = hull.receiveShadow = true;
    body.add(hull);

    const cabShape = new THREE.Shape();
    cabShape.moveTo(-0.59, 1.02);
    cabShape.lineTo(0.59, 1.02);
    cabShape.lineTo(0.49, 1.49);
    cabShape.lineTo(0.34, 1.67);
    cabShape.lineTo(-0.34, 1.67);
    cabShape.lineTo(-0.49, 1.49);
    cabShape.closePath();
    const cabGeometry = new THREE.ExtrudeGeometry(cabShape, {
      depth: 1.36, bevelEnabled: true, bevelSegments: 3, bevelSize: 0.045,
      bevelThickness: 0.045, curveSegments: 3,
    });
    cabGeometry.translate(0, 0, -0.35);
    const cab = new THREE.Mesh(cabGeometry, red);
    cab.castShadow = cab.receiveShadow = true;
    body.add(cab);

    box(body, [1.01, 0.37, 0.045], [0, 1.39, 0.91], glass, [-0.42, 0, 0]);
    box(body, [0.96, 0.34, 0.045], [0, 1.39, -0.26], glass, [0.42, 0, 0]);
    for (const side of [-1, 1]) {
      box(body, [0.045, 0.36, 0.78], [side * 0.57, 1.38, 0.28], glass);
      box(body, [0.08, 0.09, 2.06], [side * 0.95, 0.72, 0], red);
      box(body, [0.055, 0.045, 2.3], [side * 0.94, 0.48, 0], dark);
      const number = label('04', 0.82, '#14212a', '#f4eee3');
      number.position.set(side * 0.98, 0.88, 0.02);
      number.rotation.y = side * Math.PI / 2;
      body.add(number);
    }

    box(body, [0.92, 0.09, 0.72], [0, 0.99, 0.83], yellow);
    box(body, [0.44, 0.15, 0.38], [0, 1.11, 0.71], dark);
    box(body, [0.72, 0.25, 0.06], [0, 0.72, 1.39], dark);
    for (let grille = 0; grille < 5; grille++) {
      box(body, [0.035, 0.19, 0.018], [-0.24 + grille * 0.12, 0.72, 1.43], silver);
    }
    for (const side of [-1, 1]) {
      const headlight = new THREE.Mesh(
        new THREE.BoxGeometry(0.29, 0.15, 0.07),
        new THREE.MeshStandardMaterial({
          color: '#fff3ce', emissive: '#ffcf70', emissiveIntensity: 1.35,
          roughness: 0.25,
        }),
      );
      headlight.position.set(side * 0.63, 0.88, 1.37);
      body.add(headlight);
      brakeLights.push(box(body, [0.25, 0.13, 0.07], [side * 0.62, 0.83, -1.38], brakeLamp));
    }
    box(body, [1.82, 0.2, 0.22], [0, 0.43, 1.48], dark);
    box(body, [1.82, 0.2, 0.22], [0, 0.43, -1.48], dark);
    exhaustGlow = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 12, 8),
      new THREE.MeshBasicMaterial({ color: '#ff9a3d', transparent: true, opacity: 0.8 }),
    );
    exhaustGlow.position.set(0, 0.55, -1.59);
    exhaustGlow.visible = false;
    body.add(exhaustGlow);
    box(body, [1.72, 0.09, 0.3], [0, 1.5, -1.15], dark);
    for (const side of [-1, 1]) {
      box(body, [0.08, 0.42, 0.12], [side * 0.65, 1.28, -1.13], dark, [0.15, 0, side * 0.1]);
    }
    box(body, [1.16, 0.09, 0.2], [0, 1.76, 0.03], dark);
    for (let lamp = 0; lamp < 4; lamp++) {
      const spot = new THREE.Mesh(
        new THREE.CylinderGeometry(0.105, 0.12, 0.1, 16),
        new THREE.MeshStandardMaterial({
          color: '#fff5db', emissive: '#ffda8b', emissiveIntensity: 1.2,
          roughness: 0.24,
        }),
      );
      spot.position.set(-0.43 + lamp * 0.29, 1.78, 0.03);
      spot.rotation.x = Math.PI / 2;
      body.add(spot);
    }

    for (const x of [-0.88, 0.88]) {
      for (const z of [-0.87, 0.87]) {
        const wheel = new THREE.Group();
        wheel.position.set(x, 0.47, z);
        const rubber = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.29, 24), tire);
        rubber.rotation.z = Math.PI / 2;
        rubber.castShadow = true;
        wheel.add(rubber);
        const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.245, 0.245, 0.315, 20), silver);
        rim.rotation.z = Math.PI / 2;
        wheel.add(rim);
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.34, 16), dark);
        hub.rotation.z = Math.PI / 2;
        wheel.add(hub);
        const side = Math.sign(x);
        const lip = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.035, 8, 20), red);
        lip.rotation.y = Math.PI / 2;
        lip.position.x = side * 0.16;
        wheel.add(lip);
        for (let lug = 0; lug < 5; lug++) {
          const angle = lug * Math.PI * 2 / 5;
          const bolt = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), silver);
          bolt.position.set(side * 0.17, Math.sin(angle) * 0.17, Math.cos(angle) * 0.17);
          wheel.add(bolt);
        }
        body.add(wheel);
        wheels.push(wheel);
        if (z > 0) frontWheels.push(wheel);

        const arch = new THREE.Mesh(
          new THREE.TorusGeometry(0.48, 0.07, 8, 24, Math.PI),
          dark,
        );
        arch.position.set(x, 0.47, z);
        arch.rotation.y = Math.PI / 2;
        body.add(arch);
      }
    }
    body.scale.setScalar(1.12);
  } else {
    const boxV3 = (size, xyz, material) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
      mesh.position.set(...xyz);
      mesh.castShadow = true;
      body.add(mesh);
      return mesh;
    };
    body.scale.setScalar(1.25);
    boxV3([1.48, 0.42, 2.9], [0, 0.58, 0], yellow);
    boxV3([1.22, 0.52, 1.35], [0, 1.01, -0.1], glass);
    boxV3([1.3, 0.12, 1.3], [0, 1.31, -0.14], yellow);
    boxV3([1.65, 0.1, 0.35], [0, 1, -1.37], dark);
    for (const x of [-0.8, 0.8]) for (const z of [-0.94, 0.94]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.23, 18), dark);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x, 0.4, z);
      wheel.castShadow = true;
      body.add(wheel);
      wheels.push(wheel);
    }
  }

  const tireMist = [];
  if (isV4) {
    for (const side of [-1, 1]) {
      const mist = new THREE.Mesh(
        new THREE.SphereGeometry(0.42, 12, 8),
        new THREE.MeshBasicMaterial({ color: '#c7d5db', transparent: true, opacity: 0, depthWrite: false }),
      );
      mist.position.set(side * 0.78, 0.38, -1.12);
      mist.scale.set(1.15, 0.55, 1.4);
      body.add(mist);
      tireMist.push(mist);
    }
  }

  // Lluvia local a la cámara: la pista solo cambia de aspecto cuando el replay
  // marca clima lluvioso; las partículas son decorativas y no alteran la física.
  let rainGroup = null, rainAttribute = null, rainPositions = null;
  const rainCount = isV4 ? 520 : 0;
  const rainRandom = value => {
    const n = Math.sin(value * 127.1 + 311.7) * 43758.5453;
    return n - Math.floor(n);
  };
  if (isV4) {
    rainPositions = new Float32Array(rainCount * 6);
    for (let i = 0; i < rainCount; i++) {
      const j = i * 6;
      const x = rainRandom(i * 3 + 1) * 72 - 36;
      const y = rainRandom(i * 3 + 2) * 38 + 2;
      const z = rainRandom(i * 3 + 3) * 72 - 36;
      rainPositions.set([x, y, z, x + 0.1, y - 1.25, z + 0.22], j);
    }
    const rainGeometry = new THREE.BufferGeometry();
    rainAttribute = new THREE.BufferAttribute(rainPositions, 3);
    rainAttribute.setUsage(THREE.DynamicDrawUsage);
    rainGeometry.setAttribute('position', rainAttribute);
    rainGroup = new THREE.LineSegments(
      rainGeometry,
      new THREE.LineBasicMaterial({ color: '#c2e6f6', transparent: true, opacity: 0.46, depthWrite: false }),
    );
    rainGroup.frustumCulled = false;
    rainGroup.visible = false;
    scene.add(rainGroup);
  }

  // ---------- Animación de un paso ----------
  // Cada paso de Python trae: de dónde salió, a dónde llegó, si saltó y si chocó.
  // Aquí se arma un recorrido de "puntos de paso" y se interpola entre ellos.
  let legs = [], started = 0, duration = 1, lastKey = null, shownS = 0.5;
  let driveAction = null, currentSpeed = 0, skidUntil = 0;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const centerS = seg => Math.min(seg + 0.5, N);

  function heightOf(s, lane, layer) { return layer ? DECK_H : groundHeight(s, Math.round(lane)); }

  function plan(d) {
    const from = { s: centerS(d.from.segment), lane: d.from.lane, layer: d.from.layer };
    const to = { s: d.to.segment >= N ? N : centerS(d.to.segment), lane: d.to.lane, layer: d.to.layer };
    const out = [];
    if (d.gapCrossings?.length) {
      const gap = d.gapCrossings[0].segment;
      const takeoff = { s: Math.max(from.s, centerS(gap - 1)), lane: from.lane, layer: 1 };
      const landing = { s: Math.min(to.s, centerS(gap + 1)), lane: to.lane, layer: 1 };
      if (from.s < takeoff.s) out.push({ a: from, b: takeoff, kind: 'ground' });
      out.push({
        a: takeoff, b: landing, kind: 'flight', h0: DECK_H, h1: DECK_H,
        peak: 1.55,
      });
      if (landing.s < to.s) out.push({ a: landing, b: to, kind: 'ground' });
    } else if (d.jump) {
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
    const steer = (leg.b.lane - leg.a.lane) * Math.sin(Math.PI * k);
    let h, spin = 0;
    if (leg.kind === 'flight') h = THREE.MathUtils.lerp(leg.h0, leg.h1, k) + 4 * leg.peak * k * (1 - k);
    else if (leg.a.layer === leg.b.layer) h = heightOf(s, lane, leg.a.layer);
    else h = THREE.MathUtils.lerp(heightOf(s, lane, leg.a.layer), heightOf(s, lane, leg.b.layer), THREE.MathUtils.smoothstep(k, 0, 1));
    if (leg.kind === 'bounce' || leg.kind === 'fall') spin = Math.sin(k * Math.PI) * 0.9;
    return { s, lane, h, spin, steer, kind: leg.kind };
  }

  function receive(d) {
    if (!d) return;
    const nextWeather = isV4 && (d.weather === 'lluvia' || d.weather === 'rain') ? 'lluvia' : 'normal';
    const layoutChanged = Boolean(d.layout && d.layout !== layout);
    const weatherChanged = nextWeather !== weatherMode;
    if (layoutChanged) layout = d.layout;
    if (weatherChanged) {
      weatherMode = nextWeather;
      const rain = weatherMode === 'lluvia';
      const sky = rain ? rainSky : drySky;
      scene.background.copy(sky);
      scene.fog.color.copy(sky);
      scene.fog.near = rain ? 110 : 180;
      scene.fog.far = rain ? 275 : 420;
      ambient.intensity = rain ? 1.45 : isV4 ? 2.0 : 2.2;
      sun.intensity = rain ? 1.7 : isV4 ? 3.5 : 3.2;
      if (rainGroup) rainGroup.visible = rain;
    }
    if (layoutChanged || weatherChanged) buildTrack();
    driveAction = d.actionName;
    currentSpeed = Number(d.to.speed_level ?? 0);
    if (isV4 && (d.events ?? []).some(event => /derrape|choca|cae_/.test(event))) {
      skidUntil = performance.now() + Math.max(420, d.duration * 0.9);
    }
    legs = plan(d);
    const fresh = d.key !== lastKey || d.step === 0;
    lastKey = d.key;
    started = performance.now();
    duration = fresh || reduced.matches ? 0 : Math.max(60, d.duration * (isV5 ? 1 : 0.85));
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

  function updateCamera(dt, p, dir, normalIn, speedRatio = 0) {
    if (mode === 'free') { controls.update(); return; }
    const desired = new THREE.Vector3(), look = car.position.clone();
    if (mode === 'follow') {
      desired.copy(car.position).addScaledVector(dir, isV4 ? -12 - speedRatio * 4 : -15).add(new THREE.Vector3(0, isV4 ? 6.2 + speedRatio * 1.1 : 7, 0));
      look.addScaledVector(dir, isV4 ? 7 + speedRatio * 2.5 : 8).y += 1;
      if (isV4) {
        const now = performance.now();
        const impact = Math.max(0, (skidUntil - now) / 500);
        desired.add(new THREE.Vector3(Math.sin(now * 0.085) * 0.8 * impact, Math.sin(now * 0.12) * 0.35 * impact, Math.cos(now * 0.1) * 0.45 * impact));
      }
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
    if (rainGroup) {
      rainGroup.position.set(car.position.x, 0, car.position.z);
      if (weatherMode === 'lluvia' && !reduced.matches) {
        for (let i = 0; i < rainCount; i++) {
          const j = i * 6;
          let x = rainPositions[j], y = rainPositions[j + 1] - dt * (22 + i % 9), z = rainPositions[j + 2] + dt * 3.5;
          if (y < -2) {
            x = rainRandom(i * 3 + Math.floor(now / 700) + 1) * 72 - 36;
            y = 36 + rainRandom(i + Math.floor(now / 500)) * 8;
            z = rainRandom(i * 5 + Math.floor(now / 900)) * 72 - 36;
          }
          rainPositions.set([x, y, z, x + 0.1, y - 1.25, z + 0.22], j);
        }
        rainAttribute.needsUpdate = true;
      }
    }
    if (!legs.length) { renderer.render(scene, camera); return; }
    const progress = duration ? Math.min(1, (now - started) / duration) : 1;
    // En N5 los frames históricos llegan ya en pasos cortos. Mantener la
    // velocidad lineal evita frenar y arrancar visualmente en cada transición.
    const f = isV4 && !isV5 ? THREE.MathUtils.smoothstep(progress, 0, 1) : progress;
    const st = sample(f);
    const off = track.laneOffset(st.lane), p = track.pointAt(uOf(st.s), off);
    const ahead = sample(Math.min(1, f + 0.01));
    const slope = (ahead.h - st.h) / Math.max(0.02, (ahead.s - st.s) * CELL);
    car.position.set(p.x, st.h + 0.05, p.z);
    car.rotation.y = Math.atan2(p.dx, p.dz) + st.spin;
    car.rotation.x = st.kind === 'flight' || Math.abs(slope) < 3 ? -Math.atan(THREE.MathUtils.clamp(slope, -1.2, 1.2)) * 0.8 : 0;
    if (isV4) {
      const accelerating = driveAction === 'acelerar';
      const braking = driveAction === 'frenar';
      const speedRatio = currentSpeed / Math.max(1, env.max_speed_level);
      const pitch = accelerating ? -0.045 : braking ? 0.065 : 0;
      body.position.y += ((st.kind === 'flight' ? 0 : 0.035 * Math.sin(now * 0.006 * (1 + speedRatio * 2))) - body.position.y) * Math.min(1, dt * 8);
      body.rotation.x += (pitch - body.rotation.x) * Math.min(1, dt * 7);
      body.rotation.z += (-st.steer * 0.08 - body.rotation.z) * Math.min(1, dt * 8);
      for (const wheel of frontWheels) wheel.rotation.y = st.steer * 0.28;
      for (const lamp of brakeLights) lamp.material.emissiveIntensity = braking ? 3.2 : 0.45;
      if (exhaustGlow) {
        exhaustGlow.visible = accelerating && speedRatio > 0.25;
        if (exhaustGlow.visible) exhaustGlow.scale.setScalar(0.8 + 0.25 * Math.sin(now * 0.035));
      }
      const skidding = now < skidUntil;
      for (const mist of tireMist) {
        mist.visible = skidding;
        if (skidding) {
          const fade = Math.max(0, (skidUntil - now) / 500);
          mist.material.opacity = 0.28 * fade;
          mist.scale.set(1.15 + (1 - fade) * 0.7, 0.55 + (1 - fade) * 0.3, 1.4 + (1 - fade) * 0.8);
        }
      }
    }
    for (const w of wheels) w.rotation.x += (st.s - shownS) * CELL / 0.45;
    shownS = st.s;
    const dir = new THREE.Vector3(p.dx, 0, p.dz), normalIn = new THREE.Vector3(p.nx, 0, p.nz);
    updateCamera(dt, p, dir, normalIn, currentSpeed / Math.max(1, env.max_speed_level));
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
