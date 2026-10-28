import * as THREE from 'three';
import { OrbitControls } from './vendor/three/OrbitControls.js';

// Presentation only. The original SVG route and trainer remain the source of truth.
const host = document.getElementById('scene3d');
const world = host.parentElement;
const message = document.getElementById('sceneStatus');
const tools = document.querySelector('.view-tools');

try {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  host.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('aria-label', 'Circuito 3D con coche amarillo, salida y meta');
  renderer.domElement.setAttribute('role', 'img');
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#bdd0dc');
  scene.fog = new THREE.Fog('#bdd0dc', 250, 600);
  const camera = new THREE.PerspectiveCamera(40, 1, .1, 700);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 22;
  controls.maxDistance = 350;
  controls.maxPolarAngle = Math.PI / 2 - .08;
  scene.add(new THREE.HemisphereLight('#ddecff', '#62774d', 2.6));
  const sun = new THREE.DirectionalLight('#fff0d3', 3.6);
  sun.position.set(-32, 60, 30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -65, right: 65, top: 50, bottom: -50, near: 1, far: 150 });
  sun.shadow.normalBias = .035;
  scene.add(sun);

  const mat = (color, roughness = .8, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const asphalt = mat('#303940'), grass = mat('#527d56'), concrete = mat('#afc1bd');
  const white = mat('#f0eee5'), red = mat('#ed5c43'), dark = mat('#17232c');
  const yellow = mat('#ffc320', .3, .35), glass = mat('#193a4a', .18, .6);
  function box(parent, size, xyz, material) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.position.set(...xyz); mesh.castShadow = true; mesh.receiveShadow = true;
    parent.add(mesh); return mesh;
  }
  box(scene, [94, 1.5, 53], [0, -1, 0], mat('#61786e'));
  box(scene, [93.8, .25, 52.8], [0, -.14, 0], grass);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(1000, 1000), mat('#a7bcc8'));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -1.8; floor.receiveShadow = true; scene.add(floor);

  // Sample the existing curve once, then use the same arc length for the road
  // and for every intermediate animation frame (including reverse motion).
  const svgRoute = document.getElementById('racingLine');
  const routeLength = svgRoute.getTotalLength();
  const count = 1400;
  const samples = Array.from({ length: count + 1 }, (_, i) => {
    const p = svgRoute.getPointAtLength(routeLength * i / count);
    return new THREE.Vector3((p.x - 450) / 10, 0, (p.y - 245) / 10);
  });
  function point(t) {
    const f = THREE.MathUtils.clamp(t, 0, 1) * count;
    const i = Math.min(count - 1, Math.floor(f));
    return samples[i].clone().lerp(samples[i + 1], f - i);
  }
  function tangent(t) {
    const before = (t - .0005 + 1) % 1, after = (t + .0005) % 1;
    return point(after).sub(point(before)).normalize();
  }
  function ribbon(inner, outer, height, material, start = 0, end = 1, segments = 700) {
    const vertices = [], indices = [];
    for (let i = 0; i <= segments; i++) {
      const t = start + (end - start) * i / segments, p = point(t), d = tangent(t);
      for (const offset of [inner, outer]) vertices.push(p.x - d.z * offset, height, p.z + d.x * offset);
      if (i < segments) { const k = i * 2; indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices); geometry.computeVertexNormals();
    material.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(geometry, material); mesh.receiveShadow = true; scene.add(mesh);
  }
  ribbon(-4.1, 4.1, .02, concrete);
  ribbon(-3.3, 3.3, .06, asphalt);
  for (let i = 0; i < 100; i++) {
    for (const side of [-1, 1]) ribbon(side * 3.3, side * 3.85, .08, i % 2 ? white : red, i / 100, (i + 1) / 100, 8);
  }
  for (const side of [-1, 1]) ribbon(side * 2.98, side * 3.06, .085, white);
  for (let i = 0; i < 80; i++) ribbon(-.055, .055, .09, white, i / 80, (i + .42) / 80, 5);

  function label(text, width, position, color = '#e9f5f1', background = '#172b32') {
    const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 128;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = background; ctx.fillRect(0, 0, 1024, 128);
    ctx.font = '700 52px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = color; ctx.fillText(text, 512, 64);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const board = new THREE.Mesh(new THREE.PlaneGeometry(width, width / 8), new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }));
    board.position.set(...position); return board;
  }
  function gate(t, title, accent) {
    const g = new THREE.Group(), p = point(t), d = tangent(t);
    g.position.copy(p); g.rotation.y = Math.atan2(d.x, d.z);
    const paint = mat(accent, .4, .25);
    for (const x of [-4.3, 4.3]) { box(g, [.35, 4.8, .4], [x, 2.4, 0], paint); box(g, [1, .3, 1], [x, .15, 0], dark); }
    box(g, [9, .65, .45], [0, 4.7, 0], paint);
    g.add(label(title, 7.7, [0, 4.7, .24])); scene.add(g);
  }
  gate(0, 'SALIDA / META · 1 KM', '#17c4ce');
  gate(.5, 'SECTOR  ·  500 M', '#e7bf45');
  const finish = new THREE.Group(); finish.position.copy(point(0));
  finish.rotation.y = Math.atan2(tangent(0).x, tangent(0).z);
  for (let x = 0; x < 12; x++) for (let z = 0; z < 3; z++) box(finish, [.5, .02, .5], [x * .5 - 2.75, .1, z * .5 - .5], (x + z) % 2 ? dark : white);
  scene.add(finish);

  // Infield details stay outside the driving ribbon.
  box(scene, [25, .12, 10], [0, .02, 0], concrete);
  box(scene, [17, 2.8, 4], [0, 1.5, -1.5], dark);
  box(scene, [18, .22, 5], [0, 3, -1.5], white);
  for (let x = -6; x <= 6; x += 4) { box(scene, [3.4, 1.9, .05], [x, 1.2, .53], glass); box(scene, [3.5, .12, .14], [x, .2, .58], yellow); }
  scene.add(label('AUTONOMOUS / RALLY LAB', 14, [0, 2.55, .59], '#ffcf3b'));
  for (let x = -9; x <= 9; x += 3) box(scene, [.07, .03, 2.8], [x, .12, 3], white);
  for (let row = 0; row < 3; row++) {
    box(scene, [26, .45 + row * .5, 1.2], [0, (.45 + row * .5) / 2, -20 - row * 1.2], concrete);
    for (let x = -12; x < 13; x += 1.2) box(scene, [.85, .15, .65], [x, .55 + row * .5, -20 - row * 1.2], row % 2 ? white : mat('#3d7e8c'));
  }
  const foliage = [mat('#29664d'), mat('#38795a'), mat('#578851')];
  for (let i = 0; i < 22; i++) {
    const x = i < 11 ? -42 + i * 8.2 : -42 + (i - 11) * 8.2;
    const z = i < 11 ? 22 : -24.5;
    box(scene, [.25, 1.6, .25], [x, .8, z], mat('#6b5441'));
    const tree = new THREE.Mesh(new THREE.IcosahedronGeometry(1.25 + (i % 3) * .2, 1), foliage[i % 3]);
    tree.position.set(x, 2.6, z); tree.scale.y = 1.3; tree.castShadow = true; scene.add(tree);
  }

  const car = new THREE.Group(); car.name = 'rally-car'; car.scale.setScalar(1.3); scene.add(car);
  box(car, [1.48, .42, 2.9], [0, .58, 0], yellow);
  box(car, [1.22, .52, 1.35], [0, 1.01, -.1], glass);
  box(car, [1.3, .12, 1.3], [0, 1.31, -.14], yellow);
  box(car, [.28, .035, 1.05], [0, .815, .94], dark);
  box(car, [1.5, .18, .15], [0, .49, 1.5], dark);
  for (const x of [-.48, .48]) {
    box(car, [.35, .12, .06], [x, .68, 1.49], new THREE.MeshStandardMaterial({ color: '#fff4ca', emissive: '#fff2bd', emissiveIntensity: .6 }));
    box(car, [.32, .1, .06], [x, .69, -1.49], mat('#ff342d'));
  }
  box(car, [1.65, .1, .35], [0, 1, -1.37], dark);
  const wheels = [];
  for (const x of [-.8, .8]) for (const z of [-.94, .94]) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(.36, .36, .23, 20), dark);
    wheel.rotation.z = Math.PI / 2; wheel.position.set(x, .4, z); wheel.castShadow = true; car.add(wheel); wheels.push(wheel);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(.19, .19, .245, 12), mat('#b2bec6', .3, .8));
    rim.rotation.z = Math.PI / 2; rim.position.copy(wheel.position); car.add(rim);
  }

  let episode = -1, shown = 0, from = 0, target = 0, started = 0, duration = 0;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  function receive(state) {
    if (!state) return;
    if (state.episode !== episode || state.step === 0) shown = state.position;
    episode = state.episode; from = shown; target = state.position;
    started = performance.now(); duration = reducedMotion.matches ? 0 : Math.max(60, state.duration * .8);
  }
  window.addEventListener('rally:frame', event => receive(event.detail));
  receive(window.rallyVisualState);
  function cameraView(top = false) {
    const aspect = host.clientWidth / host.clientHeight;
    const scale = Math.max(1, 1.45 / aspect);
    camera.position.set(...(top ? [0, 98 * scale, .01] : [37 * scale, 56 * scale, 68 * scale]));
    controls.target.set(0, 0, 0); controls.update();
    document.getElementById('cameraOverview').setAttribute('aria-pressed', String(!top));
    document.getElementById('cameraTop').setAttribute('aria-pressed', String(top));
  }
  document.getElementById('cameraOverview').onclick = () => cameraView();
  document.getElementById('cameraTop').onclick = () => cameraView(true);
  function resize() { camera.aspect = host.clientWidth / host.clientHeight; camera.updateProjectionMatrix(); renderer.setSize(host.clientWidth, host.clientHeight); }
  new ResizeObserver(resize).observe(host); resize(); cameraView();
  renderer.setAnimationLoop(now => {
    const fraction = duration ? Math.min(1, (now - started) / duration) : 1;
    const previous = shown;
    shown = from + (target - from) * fraction;
    const t = shown / 1000, p = point(t), d = tangent(t);
    car.position.set(p.x, .09, p.z);
    car.rotation.y = Math.atan2(d.x, d.z);
    for (const wheel of wheels) wheel.rotation.x += (shown - previous) * routeLength / 10000 / .36;
    controls.update(); renderer.render(scene, camera);
  });
  renderer.domElement.addEventListener('webglcontextlost', event => {
    event.preventDefault(); renderer.setAnimationLoop(null);
    world.classList.remove('has-3d'); tools.hidden = true; message.hidden = false;
    message.textContent = 'Se perdió la vista 3D. La simulación continúa en 2D; recarga para recuperar el 3D.';
  });
  world.classList.add('has-3d'); message.hidden = true; tools.hidden = false;
} catch (error) {
  host.replaceChildren(); world.classList.remove('has-3d'); tools.hidden = true;
  message.hidden = false; message.textContent = 'Vista 2D activa. El navegador no pudo iniciar WebGL 2 para la vista 3D.';
  console.error('Rally 3D:', error);
}
