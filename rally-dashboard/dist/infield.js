// Centro del óvalo (N8): calle de pits con garajes y coches de otros equipos, paddock con camiones y carpas,
// pantalla gigante, lago, helipuerto con helicóptero, estacionamiento, trampas de arena y árboles.
// Es solo decorado: nada de esto lo "ve" la IA ni cambia lo que calcula Python.
// Coordenadas: las de Python (x a lo largo de la recta principal, y hacia adentro del óvalo, altura h).
// La recta principal está en y = -R y la de atrás en y = +R; el centro del óvalo es (0, 0).
import * as THREE from 'three';
import { mergeGeometries } from './vendor/three/addons/utils/BufferGeometryUtils.js';

function rng(seed) { let x = seed; return () => (x = (x * 16807) % 2147483647) / 2147483647; }
function canvasTex(w, h, paint) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  paint(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}

export function buildInfield({ scene, S, R, HALF, makeCar }) {
  const P = (x, y, h = 0) => new THREE.Vector3(x, h, -y);
  const X0 = -S / 2, X1 = S / 2;                     // extremos de las rectas
  const Y = d => -R + d;                             // d = metros hacia adentro desde el eje de la recta principal
  const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...o });
  const flatM = (color, o = {}) => std(color, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, ...o });

  // Todo lo que comparte material se une en UN solo objeto: pocos dibujos por cuadro = más fluido.
  const buckets = new Map();
  const put = (material, geometry) => { if (!buckets.has(material)) buckets.set(material, []); buckets.get(material).push(geometry.index ? geometry.toNonIndexed() : geometry); };
  const box = (material, w, h, l, x, y, base = 0, yaw = 0) => {      // w: a lo ancho (y), l: a lo largo (x)
    const g = new THREE.BoxGeometry(l, h, w); g.rotateY(yaw); g.translate(x, base + h / 2, -y); put(material, g);
  };
  const slab = (material, x0, x1, y0, y1, h = 0.02) => {             // rectángulo pintado en el piso
    const g = new THREE.PlaneGeometry(x1 - x0, y1 - y0); g.rotateX(-Math.PI / 2); g.translate((x0 + x1) / 2, h, -(y0 + y1) / 2); put(material, g);
  };
  const disc = (material, x, y, rx, ry, h = 0.02, seg = 48) => {
    const g = new THREE.CircleGeometry(1, seg); g.rotateX(-Math.PI / 2); g.scale(rx, 1, ry); g.translate(x, h, -y); put(material, g);
  };

  const M = {
    lane: flatM('#33373d', { roughness: 0.95 }), paddock: flatM('#565b62', { roughness: 0.95 }), white: flatM('#f2f2ee', { roughness: 0.6 }),
    yellow: flatM('#f2c230', { roughness: 0.6 }), sand: flatM('#d7c594', { roughness: 1 }), road: flatM('#44484e', { roughness: 0.95 }),
    wall: std('#e3e6e9', { roughness: 0.7 }), dark: std('#14181d', { roughness: 0.6 }), glass: std('#22405a', { metalness: 0.6, roughness: 0.15 }),
    roof: std('#aeb6bd', { metalness: 0.4, roughness: 0.5 }), concrete: std('#b9b6ae'), red: std('#d8332a', { roughness: 0.5 }),
    truck: std('#f4f5f6', { roughness: 0.5 }), tire: std('#15171a', { roughness: 0.9 }), steel: std('#c9ced3', { metalness: 0.8, roughness: 0.35 }),
  };
  const TEAM = ['#e8202a', '#1565c0', '#2e9d57', '#ff8a1e', '#8e44d6', '#11b5c9', '#f2c230', '#e84f9a'];
  const teamM = TEAM.map(c => std(c, { roughness: 0.5 }));

  // ---------- 1. calle de pits (paralela a la recta principal, por dentro) ----------
  const laneA = HALF + 7, laneB = HALF + 16, px0 = X0 + 30, px1 = X1 - 30;
  slab(M.lane, px0, px1, Y(laneA), Y(laneB), 0.015);
  slab(M.white, px0, px1, Y(laneA), Y(laneA + 0.18), 0.03); slab(M.white, px0, px1, Y(laneB - 0.18), Y(laneB), 0.03);
  for (let x = px0; x < px1; x += 9) slab(M.white, x, x + 4, Y(laneA + 3.4), Y(laneA + 3.55), 0.03);         // línea de carril rápido
  // Entrada y salida en diagonal hacia la pista (solo pintura).
  for (const [xa, xb] of [[px0 - 22, px0], [px1, px1 + 22]]) slab(M.lane, xa, xb, Y(laneA - 1.5), Y(laneA + 5), 0.014);

  // ---------- 2. edificio de garajes ----------
  const gA = HALF + 17, gB = HALF + 29, gx0 = X0 + 55, gx1 = X1 - 55, GH = 6.6, nG = 12, gw = (gx1 - gx0) / nG;
  box(M.wall, gB - gA, GH, gx1 - gx0, 0, Y((gA + gB) / 2));
  box(M.roof, gB - gA + 3, 0.35, gx1 - gx0 + 2, 0, Y((gA + gB) / 2 - 0.8), GH);                              // alero sobre los boxes
  box(M.glass, 0.3, 1.5, gx1 - gx0 - 4, 0, Y(gA - 0.1), 4.6);                                                // sala de prensa (vidrio)
  for (let i = 0; i < nG; i++) {
    const x = gx0 + gw * (i + 0.5);
    box(M.dark, 0.3, 3.4, gw * 0.78, x, Y(gA - 0.12), 0);                                                    // portón abierto
    box(teamM[i % TEAM.length], 0.34, 0.75, gw * 0.9, x, Y(gA - 0.14), 3.55);                                // franja del equipo
    slab(M.yellow, x - gw * 0.36, x + gw * 0.36, Y(laneB - 3.6), Y(laneB - 3.45), 0.03);                     // cajón de pits pintado
    slab(M.yellow, x - gw * 0.36, x - gw * 0.36 + 0.15, Y(laneB - 3.6), Y(laneB - 0.3), 0.03);
    slab(M.yellow, x + gw * 0.36 - 0.15, x + gw * 0.36, Y(laneB - 3.6), Y(laneB - 0.3), 0.03);
    for (const dx of [-gw * 0.42, gw * 0.42]) for (let k = 0; k < 3; k++) {                                   // pilas de llantas
      const t = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 12); t.translate(x + dx, 0.13 + k * 0.27, -Y(gA - 0.9)); put(M.tire, t);
    }
    box(M.red, 0.6, 1.0, 1.1, x + gw * 0.25, Y(gA - 1.3));                                                    // carro de herramientas
  }
  // Muro de pits con mallas y puestos de cronometraje.
  box(M.concrete, 0.3, 1.0, px1 - px0, 0, Y(laneA - 0.6));
  for (let x = gx0; x <= gx1; x += gw * 2) { box(M.roof, 2.2, 0.15, 5, x, Y(laneA - 0.6), 2.5); for (const dx of [-2.2, 2.2]) box(M.steel, 0.1, 2.5, 0.1, x + dx, Y(laneA - 0.6)); }
  // Torre de control en un extremo.
  box(M.wall, 9, 13, 9, gx1 + 8, Y((gA + gB) / 2)); box(M.glass, 9.4, 3, 9.4, gx1 + 8, Y((gA + gB) / 2), 9.4); box(M.roof, 11, 0.4, 11, gx1 + 8, Y((gA + gB) / 2), 13);

  // ---------- 3. paddock: camiones de los equipos y carpas ----------
  const pA = gB, pB = HALF + 50;
  slab(M.paddock, gx0 - 12, gx1 + 20, Y(pA), Y(pB), 0.012);
  for (let i = 0; i < nG; i++) {
    const x = gx0 + gw * (i + 0.5), m = teamM[i % TEAM.length];
    box(M.truck, 13, 3.3, 2.7, x - 2.2, Y(pA + 10), 0.9); box(m, 13.05, 0.7, 2.75, x - 2.2, Y(pA + 10), 2.0);    // remolque con franja
    box(m, 2.6, 2.7, 2.6, x - 2.2, Y(pA + 18.2), 0.5);                                                          // cabina
    for (const dy of [5.5, 12.5, 17.6]) for (const dx of [-1.25, 1.25]) { const t = new THREE.CylinderGeometry(0.5, 0.5, 0.35, 12); t.rotateZ(Math.PI / 2); t.translate(x - 2.2 + dx, 0.5, -Y(pA + dy)); put(M.tire, t); }
    const tent = new THREE.ConeGeometry(3.4, 2.2, 4, 1); tent.rotateY(Math.PI / 4); tent.translate(x + 3.6, 3.7, -Y(pA + 6)); put(M.truck, tent);
    for (const [dx, dy] of [[-2.2, -2.2], [2.2, -2.2], [-2.2, 2.2], [2.2, 2.2]]) box(M.steel, 0.1, 2.6, 0.1, x + 3.6 + dx, Y(pA + 6 + dy));
  }

  // ---------- 4. trampas de arena por dentro de las dos curvas ----------
  for (const [cx, sign] of [[X1, 1], [X0, -1]]) {
    const g = new THREE.RingGeometry(R - HALF - 17, R - HALF - 6.2, 48, 1, -Math.PI / 2, Math.PI);
    g.rotateX(-Math.PI / 2); if (sign < 0) g.rotateY(Math.PI); g.translate(cx, 0.0, 0); put(M.sand, g);
  }

  // ---------- 5. lago en el centro ----------
  const lake = P(8, 12, 0);
  disc(M.sand, lake.x, -lake.z, 66, 26, 0.0);
  const water = new THREE.Mesh(new THREE.CircleGeometry(1, 64).rotateX(-Math.PI / 2).scale(62, 1, 23.5).translate(lake.x, 0.04, lake.z),
    new THREE.MeshStandardMaterial({ color: '#2f7fb8', roughness: 0.08, metalness: 0.35, transparent: true, opacity: 0.9 }));
  water.receiveShadow = true; scene.add(water);
  disc(std('#6f9a2e', { roughness: 1 }), lake.x + 14, -lake.z + 2, 9, 5, 0.08, 24);                              // islote

  // ---------- 6. helipuerto con helicóptero (el rotor gira) ----------
  const heli = new THREE.Group(), hp = P(X0 + 52, 12, 0);
  disc(M.paddock, hp.x, -hp.z, 11, 11, 0.02);
  const padTex = canvasTex(256, 256, (g, w) => {
    g.fillStyle = '#565b62'; g.fillRect(0, 0, w, w); g.strokeStyle = '#f2f2ee'; g.lineWidth = 12; g.beginPath(); g.arc(w / 2, w / 2, w / 2 - 14, 0, 7); g.stroke();
    g.fillStyle = '#f2c230'; g.font = '900 150px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('H', w / 2, w / 2 + 8);
  });
  const pad = new THREE.Mesh(new THREE.CircleGeometry(9, 40).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: padTex, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
  pad.position.set(hp.x, 0.04, hp.z); pad.receiveShadow = true; scene.add(pad);
  {
    const body = new THREE.Mesh(new THREE.SphereGeometry(1.5, 16, 12).scale(1.7, 1, 1), std('#e8202a', { roughness: 0.35, metalness: 0.2 })); body.position.y = 2.0;
    const cab = new THREE.Mesh(new THREE.SphereGeometry(1.25, 14, 10).scale(1.2, 0.95, 0.95), M.glass); cab.position.set(1.25, 2.1, 0);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(5, 0.4, 0.4), std('#e8202a', { roughness: 0.4 })); tail.position.set(-4.4, 2.3, 0);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.6, 0.14), std('#f4f5f6')); fin.position.set(-6.6, 2.9, 0);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.9, 8), M.steel); mast.position.y = 3.7;
    const rotor = new THREE.Mesh(new THREE.BoxGeometry(11, 0.06, 0.34), M.dark); rotor.position.y = 4.15;
    const rotor2 = rotor.clone(); rotor2.rotation.y = Math.PI / 2;
    const spin = new THREE.Group(); spin.add(rotor, rotor2);
    const skidG = new THREE.CylinderGeometry(0.07, 0.07, 4.2, 8).rotateZ(Math.PI / 2);
    for (const z of [-1.1, 1.1]) { const sk = new THREE.Mesh(skidG, M.steel); sk.position.set(0.2, 0.25, z); heli.add(sk); }
    heli.add(body, cab, tail, fin, mast, spin); heli.userData.spin = spin;
    heli.traverse(o => { if (o.isMesh) o.castShadow = true; });
    heli.position.set(hp.x, 0.04, hp.z); heli.rotation.y = 0.6; scene.add(heli);
  }

  // ---------- 7. recta de atrás por dentro: carpas de invitados, estacionamiento y camino de servicio ----------
  const bY = d => R - d;                              // d = metros hacia adentro desde el eje de la recta de atrás
  slab(M.paddock, X0 + 40, X1 - 40, bY(HALF + 34), bY(HALF + 10), 0.012);
  for (let x = X0 + 40; x < X1 - 40; x += 6) slab(M.white, x, x + 0.14, bY(HALF + 33), bY(HALF + 27.5), 0.03);
  for (let x = X0 + 40; x < X1 - 40; x += 6) slab(M.white, x, x + 0.14, bY(HALF + 19.5), bY(HALF + 14), 0.03);
  for (let i = 0; i < 9; i++) {
    const x = X0 + 62 + i * 22;
    const tent = new THREE.ConeGeometry(5, 3, 4, 1); tent.rotateY(Math.PI / 4); tent.translate(x, 4.5, -bY(HALF + 5.2 + 5)); put(i % 2 ? M.truck : teamM[i % TEAM.length], tent);
    box(M.wall, 6.6, 3, 6.6, x, bY(HALF + 10.2));
  }
  slab(M.road, X0 + 22, X0 + 28, Y(pB), bY(HALF + 34), 0.012); slab(M.road, X1 - 28, X1 - 22, Y(pB), bY(HALF + 34), 0.012);   // caminos que cruzan
  slab(M.road, X0 + 22, X1 - 22, Y(pB), Y(pB + 5), 0.012);

  for (const [m, list] of buckets) {
    const mesh = new THREE.Mesh(mergeGeometries(list.map(g => { if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2)); return g; })), m);
    mesh.castShadow = !m.polygonOffset; mesh.receiveShadow = true; scene.add(mesh);
  }

  // ---------- 8. coches estacionados (instanciados), mecánicos y comisarios ----------
  const r = rng(2026), o = new THREE.Object3D(), tint = new THREE.Color();
  {
    const spots = [];
    for (const d of [HALF + 30.2, HALF + 16.8]) for (let x = X0 + 43; x < X1 - 42; x += 6) if (r() < 0.78) spots.push([x, bY(d), r() < 0.5 ? 0 : Math.PI]);
    const bodyG = new THREE.BoxGeometry(1.8, 0.7, 4.2).translate(0, 0.6, 0), cabG = new THREE.BoxGeometry(1.6, 0.6, 2.1).translate(0, 1.2, -0.2);
    const bodies = new THREE.InstancedMesh(bodyG, std('#ffffff', { roughness: 0.35, metalness: 0.3 }), spots.length), cabs = new THREE.InstancedMesh(cabG, std('#1c2630', { roughness: 0.2, metalness: 0.5 }), spots.length);
    const paint = ['#d8dde2', '#20242a', '#9b1c1c', '#1e4f9a', '#f4f4f2', '#6c7680', '#2e6b3a', '#c9a227'];
    spots.forEach(([x, y, yaw], i) => { o.position.copy(P(x, y)); o.rotation.set(0, yaw, 0); o.scale.setScalar(1); o.updateMatrix(); bodies.setMatrixAt(i, o.matrix); cabs.setMatrixAt(i, o.matrix); bodies.setColorAt(i, tint.set(paint[Math.floor(r() * paint.length)])); });
    bodies.castShadow = true; scene.add(bodies, cabs);
  }
  {
    // Mecánicos (overol del color del equipo) frente a cada garaje y comisarios de naranja junto a la pista.
    const people = [];
    for (let i = 0; i < nG; i++) { const x = gx0 + gw * (i + 0.5); for (let k = 0; k < 5; k++) people.push([x + (r() - 0.5) * gw * 0.8, Y(gA - 1 - r() * 5), TEAM[i % TEAM.length]]); }
    for (let x = px0; x < px1; x += 23) people.push([x, Y(laneA - 1.6), '#ff7a1a']);
    for (let i = 0; i < 26; i++) people.push([X0 + 50 + r() * (S - 100), Y(pA + 2 + r() * 20), '#e9edf0']);
    const bodyG = new THREE.CylinderGeometry(0.2, 0.24, 1.25, 6).translate(0, 0.63, 0), headG = new THREE.IcosahedronGeometry(0.15, 0).translate(0, 1.45, 0);
    const bodies = new THREE.InstancedMesh(bodyG, std('#ffffff'), people.length), heads = new THREE.InstancedMesh(headG, std('#e0ac69'), people.length);
    people.forEach(([x, y, c], i) => { o.position.copy(P(x, y)); o.rotation.set(0, 0, 0); o.scale.setScalar(0.95 + r() * 0.15); o.updateMatrix(); bodies.setMatrixAt(i, o.matrix); heads.setMatrixAt(i, o.matrix); bodies.setColorAt(i, tint.set(c)); });
    bodies.castShadow = true; scene.add(bodies, heads);
  }

  // ---------- 9. árboles: dentro de las curvas y alrededor del lago ----------
  {
    const trees = [];
    for (const cx of [X1, X0]) for (let i = 0; i < 46; i++) {
      const a = (r() - 0.5) * Math.PI * 0.92, rad = 8 + r() * (R - HALF - 30), x = cx + Math.sign(cx) * Math.cos(a) * rad, y = Math.sin(a) * rad;
      if (!(cx > 0 && Math.abs(x - (X1 + 26)) < 12 && Math.abs(y) < 36)) trees.push([x, y, 5 + r() * 6]);
    }
    for (let i = 0; i < 40; i++) { const a = r() * Math.PI * 2, x = lake.x + Math.cos(a) * (72 + r() * 10), y = -lake.z + Math.sin(a) * (31 + r() * 6); if (Math.abs(x) < S / 2 - 30 && y > Y(pB + 7) && y < bY(HALF + 37)) trees.push([x, y, 4 + r() * 5]); }
    const crown = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 7).translate(0, 0.5, 0), std('#2f5e2b', { roughness: 0.95 }), trees.length);
    const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12, 0.18, 1, 5).translate(0, 0.5, 0), std('#5b3d24'), trees.length);
    trees.forEach(([x, y, h], i) => {
      o.rotation.set(0, 0, 0); o.position.copy(P(x, y, h * 0.25)); o.scale.set(h * 0.32, h * 0.8, h * 0.32); o.updateMatrix(); crown.setMatrixAt(i, o.matrix);
      crown.setColorAt(i, tint.setHSL(0.27 + r() * 0.08, 0.45, 0.2 + r() * 0.12));
      o.position.copy(P(x, y, 0)); o.scale.set(h * 0.08, h * 0.3, h * 0.08); o.updateMatrix(); trunk.setMatrixAt(i, o.matrix);
    });
    crown.castShadow = true; scene.add(crown, trunk);
  }

  // ---------- 10. pantalla gigante sobre los garajes y letrero pintado en el pasto ----------
  {
    const tex = canvasTex(1024, 512, (g, w, h) => {
      const grd = g.createLinearGradient(0, 0, 0, h); grd.addColorStop(0, '#0b1a2a'); grd.addColorStop(1, '#13324d'); g.fillStyle = grd; g.fillRect(0, 0, w, h);
      g.fillStyle = '#ffd12e'; g.font = '900 150px system-ui, sans-serif'; g.textAlign = 'center'; g.fillText('RALLY IA', w / 2, 210);
      g.fillStyle = '#e8f0f4'; g.font = '700 60px system-ui, sans-serif'; g.fillText(window.RALLY_SCREEN ?? 'EN VIVO · PYTHON + 3D', w / 2, 330);
      g.fillStyle = '#47df9a'; g.fillRect(w * 0.2, 400, w * 0.6, 14);
    });
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(26, 13), new THREE.MeshStandardMaterial({ map: tex, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 0.9 }));
    scr.position.copy(P(0, Y(gA + 4), GH + 8.2)); scr.rotation.y = 0;      // mira hacia la recta principal (+z en Three = -y de Python)
    const frame = new THREE.Mesh(new THREE.BoxGeometry(27, 14, 0.6), M.dark); frame.position.copy(scr.position); frame.position.z -= 0.35;
    for (const dx of [-9, 9]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.6, 2.6, 0.6), M.steel); leg.position.set(dx, GH + 0.6, scr.position.z - 0.4); scene.add(leg); }
    scene.add(scr, frame);
    const sign = canvasTex(1024, 256, (g, w, h) => { g.clearRect(0, 0, w, h); g.fillStyle = 'rgba(255,255,255,0.92)'; g.font = '900 190px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('RALLY IA', w / 2, h / 2 + 8); });
    const painted = new THREE.Mesh(new THREE.PlaneGeometry(64, 16).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: sign, transparent: true, roughness: 1, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
    painted.position.copy(P(X1 + 26, 0, 0.03)); painted.rotation.y = -Math.PI / 2; painted.renderOrder = 1; scene.add(painted);
  }

  // ---------- 11. coches de otros equipos en sus cajones de pits ----------
  const parked = [];
  function addCars() {
    if (!makeCar) return;
    [1, 3, 4, 6, 8, 10].forEach((i, k) => {
      const c = makeCar(TEAM[i % TEAM.length]); if (!c) return;
      c.position.copy(P(gx0 + gw * (i + 0.5), Y(laneB - 1.9), 0)); c.rotation.y = Math.PI / 2 + (k % 2 ? 0.06 : -0.04); scene.add(c); parked.push(c);
    });
  }

  return { addCars, update(time) { heli.userData.spin.rotation.y = time * 9; } };
}
