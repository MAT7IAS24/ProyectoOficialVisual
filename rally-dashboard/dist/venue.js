// Escenario del rally (N6 en adelante): cielo con atmósfera real, luz de una foto 360° (HDRI de Poly Haven,
// CC0), tribunas por niveles alrededor de todo el óvalo, público animado, techo sobre la recta principal,
// torres de luces, banderas, vallas publicitarias, guardarraíl, árboles y colinas en el horizonte.
// Todo se construye en el navegador: no cambia nada de lo que calcula Python, solo el decorado.
import * as THREE from 'three';
import { Sky } from './vendor/three/addons/objects/Sky.js';
import { EXRLoader } from './vendor/three/addons/loaders/EXRLoader.js';

function rng(seed) { let x = seed; return () => (x = (x * 16807) % 2147483647) / 2147483647; }

function canvasTex(w, h, paint) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  paint(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}

export function buildVenue({ scene, renderer, sun, sunDir, at, center, L, S, R, HALF, mat }) {
  const updaters = [];
  const uniforms = { uTime: { value: 0 }, uCar: { value: new THREE.Vector3() } };

  // ---------- cielo: modelo de atmósfera (Preetham) con el sol en la misma dirección que la luz ----------
  const sky = new Sky(); sky.scale.setScalar(4500); scene.add(sky);
  Object.assign(sky.material.uniforms.turbidity, { value: 2.6 });
  Object.assign(sky.material.uniforms.rayleigh, { value: 2.2 });
  Object.assign(sky.material.uniforms.mieCoefficient, { value: 0.004 });
  Object.assign(sky.material.uniforms.mieDirectionalG, { value: 0.86 });
  sky.material.uniforms.sunPosition.value.copy(sunDir);
  scene.fog = new THREE.Fog(new THREE.Color('#b9cfe2'), 380, 2400);
  // Luz ambiental y reflejos de una foto 360° real (Poly Haven, CC0): el coche refleja cielo de verdad.
  const pmrem = new THREE.PMREMGenerator(renderer);
  new EXRLoader().load('models3d/hdri/cielo.exr', tex => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = pmrem.fromEquirectangular(tex).texture;
    scene.environmentIntensity = 0.4;
    tex.dispose();
  }, undefined, () => {});

  // ---------- geometría: barrer un perfil (distancia a la pista, altura) a lo largo del óvalo ----------
  const cx = (() => { let x = 0, y = 0; const n = 200; for (let i = 0; i < n; i++) { const c = center(L * i / n); x += c[0]; y += c[1]; } return [x / n, y / n]; })();
  const probe = at(S + Math.PI * R / 2, 10), probe2 = at(S + Math.PI * R / 2, -10);
  const OUT = Math.hypot(probe.x - cx[0], probe.z + cx[1]) > Math.hypot(probe2.x - cx[0], probe2.z + cx[1]) ? 1 : -1;   // lado de afuera
  function sweep(profile, s0, s1, step = 3, side = OUT, closed = false) {
    const n = Math.max(1, Math.ceil((s1 - s0) / step)), m = profile.length, pos = [], uv = [], idx = [];
    for (let i = 0; i <= n; i++) {
      const s = s0 + (s1 - s0) * i / n;
      let acc = 0;
      profile.forEach(([d, h], k) => {
        const p = at(s, side * d, h); pos.push(p.x, p.y, p.z);
        if (k) acc += Math.hypot(d - profile[k - 1][0], h - profile[k - 1][1]);
        uv.push(s / 4, acc / 4);
      });
      if (i < n) for (let k = 0; k < m - 1; k++) { const a = i * m + k, b = a + m; side > 0 ? idx.push(a, b, a + 1, a + 1, b, b + 1) : idx.push(a, a + 1, b, a + 1, b + 1, b); }
    }
    let g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
    g = g.toNonIndexed(); g.computeVertexNormals(); return g;
  }

  // ---------- guardarraíl y vallas publicitarias a los dos lados ----------
  const steel = new THREE.MeshStandardMaterial({ color: '#c9ced3', metalness: 0.85, roughness: 0.32 });
  for (const side of [1, -1]) {
    const d = HALF + 3.7;
    const rail = new THREE.Mesh(sweep([[d, 0.45], [d + 0.06, 0.55], [d + 0.06, 0.75], [d, 0.85]], 0, L, 2, side), steel); rail.castShadow = rail.receiveShadow = true; scene.add(rail);
  }
  const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 0.85, 0.12).translate(0, 0.42, 0), steel, Math.ceil(L / 4) * 2);
  { const o = new THREE.Object3D(); let k = 0; for (const side of [1, -1]) for (let s = 0; s < L; s += 4) { o.position.copy(at(s, side * (HALF + 3.78), 0)); o.updateMatrix(); posts.setMatrixAt(k++, o.matrix); } posts.count = k; scene.add(posts); }
  const ads = ['AUTONOMOUS RALLY', 'APRENDIZAJE POR REFUERZO', 'N6 · PESO Y SUSPENSIÓN', 'DATOS · MODELOS · VERSIONES', 'PPO vs Q-LEARNING', 'RALLY IA 2026'];
  const adColors = [['#e8202a', '#fff'], ['#0b3d91', '#ffd12e'], ['#111', '#47df9a'], ['#ffd12e', '#111'], ['#f5f5f5', '#0b3d91'], ['#1d8a4a', '#fff']];
  const adTex = canvasTex(2048, 64, (g, w, h) => {
    const seg = w / ads.length;
    ads.forEach((t, i) => { g.fillStyle = adColors[i][0]; g.fillRect(i * seg, 0, seg, h); g.fillStyle = adColors[i][1]; g.font = '800 38px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(t, i * seg + seg / 2, h / 2 + 2); });
  });
  adTex.wrapS = THREE.RepeatWrapping;
  const adMat = new THREE.MeshStandardMaterial({ map: adTex, roughness: 0.55, side: THREE.DoubleSide });
  for (const side of [1, -1]) {
    const g = sweep([[HALF + 5.2, 0.0], [HALF + 5.2, 1.0]], 0, L, 2, side);
    // El texto se lee desde la pista: de un lado la textura va al derecho y del otro al revés.
    const uvs = g.attributes.uv; for (let i = 0; i < uvs.count; i++) uvs.setXY(i, uvs.getX(i) * 4 / 64 * (side === OUT ? -1 : 1), uvs.getY(i) > 0.01 ? 1 : 0);
    const m = new THREE.Mesh(g, adMat); m.receiveShadow = true; scene.add(m);
  }

  // ---------- tribunas por niveles alrededor de todo el óvalo (afuera) ----------
  const ROWS = 16, D0 = HALF + 9, DEPTH = 0.9, RISE = 0.48, FRONT = 2.2;
  const prof = [[D0 - 1.5, 0], [D0 - 1.5, FRONT]];
  for (let r = 0; r < ROWS; r++) { const d = D0 + r * DEPTH, h = FRONT + r * RISE; prof.push([d, h], [d, h + RISE]); }
  const back = D0 + ROWS * DEPTH;
  prof.push([back, FRONT + ROWS * RISE], [back, FRONT + ROWS * RISE + 2.4], [back + 0.4, FRONT + ROWS * RISE + 2.4], [back + 0.4, 0]);
  const concreteTex = canvasTex(256, 256, (g, w, h) => {
    const r = rng(3); g.fillStyle = '#b8b5ad'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 3000; i++) { const c = 150 + r() * 70; g.fillStyle = `rgba(${c},${c},${c - 6},0.35)`; g.fillRect(r() * w, r() * h, 2, 2); }
    g.fillStyle = 'rgba(80,80,80,0.25)'; for (let y = 0; y < h; y += 64) g.fillRect(0, y, w, 2);
  });
  concreteTex.wrapS = concreteTex.wrapT = THREE.RepeatWrapping;
  const concrete = new THREE.MeshStandardMaterial({ map: concreteTex, roughness: 0.92 });
  const stands = new THREE.Mesh(sweep(prof, 0, L + 0.5, 3), concrete); stands.receiveShadow = true; stands.castShadow = true; scene.add(stands);
  // Asientos: franjas de color por sectores (colores de equipos) en el borde de cada escalón.
  const seatCols = ['#c62828', '#1565c0', '#f9a825', '#2e7d32', '#6a1b9a', '#ef6c00'].map(c => new THREE.Color(c));
  {
    const pos = [], col = [], nS = Math.ceil(L / 3);
    for (let i = 0; i < nS; i++) {
      const s0 = i * 3, s1 = s0 + 3, sector = Math.floor(s0 / 40) % seatCols.length;
      for (let r = 0; r < ROWS; r++) {
        const d = D0 + r * DEPTH + 0.15, h = FRONT + r * RISE + RISE + 0.02, c = seatCols[(sector + (r > ROWS / 2 ? 1 : 0)) % seatCols.length];
        const q = [at(s0, OUT * d, h), at(s1, OUT * d, h), at(s0, OUT * (d + 0.45), h), at(s1, OUT * (d + 0.45), h)];
        for (const p of [q[0], q[2], q[1], q[1], q[2], q[3]]) { pos.push(p.x, p.y, p.z); col.push(c.r, c.g, c.b); }
      }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.computeVertexNormals();
    scene.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide })));
  }

  // ---------- techo sobre la recta principal (con columnas) ----------
  {
    const top = FRONT + ROWS * RISE + 2.4, s0 = -40, s1 = S * 0.75;
    const roof = new THREE.Mesh(sweep([[D0 - 3, top + 7.5], [back + 1, top + 4.2], [back + 1, top + 3.8], [D0 - 3, top + 7.1]], s0, s1, 4), new THREE.MeshStandardMaterial({ color: '#e9edf0', metalness: 0.3, roughness: 0.45, side: THREE.DoubleSide }));
    roof.castShadow = true; scene.add(roof);
    const col = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.28, 1, 10), steel, 40); const o = new THREE.Object3D(); let k = 0;
    for (let s = s0 + 8; s < s1; s += 16) { const p = at(s, OUT * (back + 0.6), 0); const hgt = top + 4.2; o.position.set(p.x, hgt / 2, p.z); o.scale.set(1, hgt, 1); o.updateMatrix(); col.setMatrixAt(k++, o.matrix); }
    col.count = k; col.castShadow = true; scene.add(col);
  }

  // ---------- público: miles de personas instanciadas, animadas en la GPU ----------
  {
    const r = rng(42), spots = [];
    for (let row = 0; row < ROWS; row++) {
      const d = D0 + row * DEPTH + 0.45, h = FRONT + row * RISE + RISE;
      for (let s = 0; s < L; s += 0.95) {
        const fill = (s % L) < S * 0.8 || (s % L) > L - 40 ? 0.92 : 0.7;      // la recta principal está más llena
        if (r() < fill) spots.push([s + (r() - 0.5) * 0.3, d + (r() - 0.5) * 0.15, h]);
      }
    }
    const N = spots.length;
    const bodyG = new THREE.CylinderGeometry(0.2, 0.24, 0.62, 7).translate(0, 0.36, 0);
    const headG = new THREE.IcosahedronGeometry(0.12, 1).translate(0, 0.8, 0);
    const shirts = ['#d32f2f', '#1976d2', '#fbc02d', '#388e3c', '#f5f5f5', '#212121', '#7b1fa2', '#ff7043', '#00838f', '#c2185b'].map(c => new THREE.Color(c));
    const skins = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac'].map(c => new THREE.Color(c));
    const animate = m => {
      m.onBeforeCompile = sh => {
        Object.assign(sh.uniforms, uniforms);
        sh.vertexShader = 'uniform float uTime; uniform vec3 uCar;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
          vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          float hsh = fract(sin(dot(ip.xz, vec2(12.9898, 78.233))) * 43758.5453);
          float near = smoothstep(70.0, 12.0, distance(ip.xz, uCar.xz));
          transformed.y += sin(uTime * (1.5 + hsh * 2.0) + hsh * 6.28) * 0.025 + max(0.0, sin(uTime * 9.0 + hsh * 6.28)) * 0.32 * near;`);
      };
      return m;
    };
    const bodies = new THREE.InstancedMesh(bodyG, animate(new THREE.MeshStandardMaterial({ roughness: 0.85 })), N);
    const heads = new THREE.InstancedMesh(headG, animate(new THREE.MeshStandardMaterial({ roughness: 0.7 })), N);
    const o = new THREE.Object3D();
    spots.forEach(([s, d, h], i) => {
      o.position.copy(at(s, OUT * d, h)); o.rotation.y = Math.atan2(-(at(s, 0, 0).x - o.position.x), -(at(s, 0, 0).z - o.position.z)) + Math.PI;
      const sc = 0.9 + r() * 0.25; o.scale.set(sc, sc, sc); o.updateMatrix();
      bodies.setMatrixAt(i, o.matrix); heads.setMatrixAt(i, o.matrix);
      bodies.setColorAt(i, shirts[Math.floor(r() * shirts.length)]); heads.setColorAt(i, skins[Math.floor(r() * skins.length)]);
    });
    bodies.frustumCulled = heads.frustumCulled = false;
    scene.add(bodies, heads);
  }

  // ---------- banderas que ondean en lo alto de las tribunas ----------
  {
    const top = FRONT + ROWS * RISE + 2.4, n = Math.floor(L / 18);
    const poleG = new THREE.CylinderGeometry(0.05, 0.05, 5, 6).translate(0, 2.5, 0);
    const flagG = new THREE.PlaneGeometry(1.8, 1.1, 10, 1).translate(0.9, 4.3, 0);
    const poles = new THREE.InstancedMesh(poleG, steel, n);
    const flagM = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.8 });
    flagM.onBeforeCompile = sh => { Object.assign(sh.uniforms, uniforms); sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      float w = position.x / 1.8; transformed.z += sin(uTime * 5.0 + position.x * 3.0 + instanceMatrix[3][0] * 0.1) * 0.22 * w; transformed.y -= w * w * 0.15;`); };
    const flags = new THREE.InstancedMesh(flagG, flagM, n);
    const o = new THREE.Object3D(), r = rng(9);
    for (let i = 0; i < n; i++) {
      const s = i * 18; o.position.copy(at(s, OUT * (back + 0.2), top)); o.rotation.y = yawAlong(s); o.updateMatrix();
      poles.setMatrixAt(i, o.matrix); flags.setMatrixAt(i, o.matrix); flags.setColorAt(i, seatCols[Math.floor(r() * seatCols.length)]);
    }
    scene.add(poles, flags);
  }
  function yawAlong(s) { return center(s)[2] + Math.PI / 2; }

  // ---------- torres de luces ----------
  {
    const top = FRONT + ROWS * RISE + 2.4;
    const towerG = new THREE.CylinderGeometry(0.35, 0.55, 1, 8).translate(0, 0.5, 0);
    const panelG = new THREE.BoxGeometry(5, 3, 0.5);
    const lampM = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff6d8', emissiveIntensity: 1.6 });
    for (const s of [S * 0.1, S * 0.6, S + Math.PI * R / 2, S * 1.1 + Math.PI * R, S * 1.7 + Math.PI * R, L - Math.PI * R / 2]) {
      const p = at(s, OUT * (back + 6), 0), H = top + 22;
      const tw = new THREE.Mesh(towerG, steel); tw.position.copy(p); tw.scale.set(1, H, 1); tw.castShadow = true; scene.add(tw);
      const panel = new THREE.Mesh(panelG, lampM); panel.position.set(p.x, H + 1.5, p.z); panel.rotation.y = yawAlong(s); panel.rotation.x = -0.35; scene.add(panel);
    }
  }

  // ---------- alrededores: árboles y colinas con neblina ----------
  {
    const r = rng(77), trees = [], ring = back + 30;
    for (let i = 0; i < 700; i++) {
      const s = r() * L, d = ring + r() * 160;
      const p = at(s, OUT * d, 0); trees.push([p.x, p.z, 7 + r() * 9]);
    }
    for (let i = 0; i < 90; i++) { const s = r() * L, d = -(HALF + 20 + r() * (R - HALF - 35)); const p = at(s, OUT * d, 0); trees.push([p.x, p.z, 5 + r() * 6]); }
    const crown = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 8).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: '#2f5e2b', roughness: 0.95 }), trees.length);
    const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12, 0.18, 1, 6).translate(0, 0.5, 0), mat('#5b3d24'), trees.length);
    const o = new THREE.Object3D(), tint = new THREE.Color();
    trees.forEach(([x, z, h], i) => {
      o.position.set(x, h * 0.25, z); o.scale.set(h * 0.32, h * 0.8, h * 0.32); o.updateMatrix(); crown.setMatrixAt(i, o.matrix);
      crown.setColorAt(i, tint.setHSL(0.27 + r() * 0.08, 0.45, 0.2 + r() * 0.12));
      o.position.set(x, 0, z); o.scale.set(h * 0.08, h * 0.3, h * 0.08); o.updateMatrix(); trunk.setMatrixAt(i, o.matrix);
    });
    crown.castShadow = true; scene.add(crown, trunk);
    // Colinas lejanas: un anillo de cerros suaves (la neblina las aclara con la distancia).
    const hills = new THREE.Group(), hm = new THREE.MeshStandardMaterial({ color: '#5f7d55', roughness: 1, flatShading: true });
    for (let i = 0; i < 26; i++) {
      const a = i / 26 * Math.PI * 2 + r() * 0.2, dist = 900 + r() * 500, w = 260 + r() * 300, hgt = 70 + r() * 140;
      const hill = new THREE.Mesh(new THREE.ConeGeometry(w, hgt, 7, 1), hm); hill.position.set(cx[0] + Math.cos(a) * dist, hgt / 2 - 6, -cx[1] + Math.sin(a) * dist); hill.rotation.y = r() * 3; hills.add(hill);
    }
    scene.add(hills);
  }

  // ---------- adentro del óvalo: pantalla gigante, carpas y edificio de boxes ----------
  {
    const IN = -OUT;
    const screenTex = canvasTex(1024, 512, (g, w, h) => {
      const grd = g.createLinearGradient(0, 0, 0, h); grd.addColorStop(0, '#0b1a2a'); grd.addColorStop(1, '#13324d'); g.fillStyle = grd; g.fillRect(0, 0, w, h);
      g.fillStyle = '#ffd12e'; g.font = '900 150px system-ui, sans-serif'; g.textAlign = 'center'; g.fillText('RALLY IA', w / 2, 210);
      g.fillStyle = '#e8f0f4'; g.font = '700 64px system-ui, sans-serif'; g.fillText('EN VIVO · PYTHON + 3D', w / 2, 330);
      g.fillStyle = '#47df9a'; g.fillRect(w * 0.2, 400, w * 0.6, 14);
    });
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(24, 12), new THREE.MeshStandardMaterial({ map: screenTex, emissive: '#ffffff', emissiveMap: screenTex, emissiveIntensity: 0.9 }));
    const sp = at(S * 0.45, IN * (HALF + 26), 9.5); scr.position.copy(sp); scr.rotation.y = center(S * 0.45)[2] + Math.PI / 2 + (IN > 0 ? Math.PI / 2 : -Math.PI / 2) - Math.PI / 2;
    scr.lookAt(at(S * 0.45, 0, 9.5)); scene.add(scr);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(25, 13, 0.6), mat('#1b1f24')); frame.position.copy(sp); frame.quaternion.copy(scr.quaternion); frame.translateZ(-0.35); scene.add(frame);
    for (const off of [-8, 8]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.6, 3.5, 0.6), mat('#2a2f36')); leg.position.copy(sp); leg.quaternion.copy(scr.quaternion); leg.translateX(off); leg.translateZ(-0.4); leg.position.y = 1.75; scene.add(leg); }
    // Carpas blancas (zona de equipos).
    const tentG = new THREE.ConeGeometry(4.2, 4, 4, 1).rotateY(Math.PI / 4).translate(0, 4.5, 0), baseG = new THREE.BoxGeometry(5.9, 2.5, 5.9).translate(0, 1.25, 0);
    const tents = new THREE.InstancedMesh(tentG, mat('#f4f4f2', { roughness: 0.7 }), 10), bases = new THREE.InstancedMesh(baseG, mat('#d9dde2'), 10), o = new THREE.Object3D();
    for (let i = 0; i < 10; i++) { o.position.copy(at(S * 0.15 + i * 9, IN * (HALF + 30), 0)); o.rotation.y = center(S * 0.15)[2]; o.updateMatrix(); tents.setMatrixAt(i, o.matrix); bases.setMatrixAt(i, o.matrix); }
    tents.castShadow = bases.castShadow = true; scene.add(tents, bases);
    // Edificio de boxes junto a la recta de meta (adentro).
    const pit = new THREE.Mesh(sweep([[HALF + 14, 0], [HALF + 14, 6], [HALF + 24, 6], [HALF + 24, 0]], L - 120, L - 10, 10, IN), new THREE.MeshStandardMaterial({ color: '#d6dbe0', roughness: 0.6 }));
    pit.castShadow = pit.receiveShadow = true; scene.add(pit);
    const glass = new THREE.Mesh(sweep([[HALF + 13.95, 2.5], [HALF + 13.95, 5.2]], L - 118, L - 12, 10, IN), new THREE.MeshStandardMaterial({ color: '#28465e', metalness: 0.6, roughness: 0.15 }));
    scene.add(glass);
  }

  return {
    update(time, carPos) { uniforms.uTime.value = time; if (carPos) uniforms.uCar.value.copy(carPos); },
  };
}
