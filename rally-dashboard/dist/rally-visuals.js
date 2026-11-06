import * as THREE from 'three';

// Procedural textures keep the dashboard self-contained and work offline.
export function surfaceTexture(kind) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  let seed = kind === 'asphalt' ? 2187 : 4381;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  ctx.fillStyle = kind === 'asphalt' ? '#4a5051' : '#6e8d61';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 12000; i++) {
    const v = Math.floor(random() * 75), a = .025 + random() * .12;
    ctx.fillStyle = kind === 'asphalt' ? `rgba(${v + 90},${v + 90},${v + 90},${a})` : `rgba(${v + 40},${v + 70},${v + 25},${a})`;
    const size = random() * 1.8 + .3;
    ctx.fillRect(random() * 256, random() * 256, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

export function createRallyCar() {
  const car = new THREE.Group();
  car.name = 'rally-car';
  car.scale.setScalar(1.3);
  const paint = new THREE.MeshStandardMaterial({color: '#ffb900', roughness: .28, metalness: .4});
  const black = new THREE.MeshStandardMaterial({color: '#172029', roughness: .6, metalness: .2});
  const glass = new THREE.MeshStandardMaterial({color: '#284c5b', roughness: .14, metalness: .45});
  const rubber = new THREE.MeshStandardMaterial({color: '#15191b', roughness: .94});
  const silver = new THREE.MeshStandardMaterial({color: '#c6d0d0', roughness: .32, metalness: .8});
  const white = new THREE.MeshStandardMaterial({color: '#f4f1d8', emissive: '#ffdc91', emissiveIntensity: .7});
  const red = new THREE.MeshStandardMaterial({color: '#b71613', emissive: '#e12e14', emissiveIntensity: .3});
  const addBox = (size, pos, material, parent = car) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.position.set(...pos); mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
  };
  addBox([1.48, .38, 2.85], [0, .58, 0], paint);
  addBox([1.38, .18, 1.15], [0, .83, .83], paint);
  addBox([1.2, .43, 1.2], [0, 1.02, -.2], glass);
  addBox([1.24, .1, 1.14], [0, 1.27, -.2], paint);
  addBox([.12, .08, 1.14], [0, 1.33, -.2], black);
  addBox([.22, .025, .85], [0, .935, 1], black);
  addBox([1.48, .15, .12], [0, .43, 1.44], black);
  addBox([.68, .18, .04], [0, .57, 1.46], black);
  addBox([1.48, .14, .12], [0, .43, -1.44], black);
  for (const x of [-.55, .55]) {
    addBox([.25, .11, .05], [x, .72, 1.45], white);
    addBox([.26, .09, .05], [x, .7, -1.45], red);
    addBox([.22, .1, .24], [x * 1.49, 1.03, .18], black);
    addBox([.06, .24, .12], [x, 1.04, -1.26], black);
  }
  addBox([1.62, .08, .34], [0, 1.17, -1.3], black);
  const wheels = [];
  for (const x of [-.78, .78]) for (const z of [-.92, .92]) {
    const wheel = new THREE.Group(); wheel.position.set(x, .37, z); car.add(wheel);
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(.37, .37, .3, 24), rubber);
    tire.rotation.z = Math.PI / 2; tire.castShadow = true; wheel.add(tire);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(.22, .22, .312, 16), silver);
    rim.rotation.z = Math.PI / 2; wheel.add(rim);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(.075, .075, .32, 12), black);
    hub.rotation.z = Math.PI / 2; wheel.add(hub);
    for (let i = 0; i < 5; i++) {
      const angle = i * Math.PI * 2 / 5;
      const spoke = addBox([.33, .045, .045], [0, Math.cos(angle) * .12, Math.sin(angle) * .12], black, wheel);
      spoke.rotation.x = angle;
    }
    wheels.push(wheel);
  }
  return {car, wheels};
}

export function addTrackDetails(scene, point, tangent) {
  const pole = new THREE.MeshStandardMaterial({color: '#d1d9d7', metalness: .55, roughness: .4});
  const dark = new THREE.MeshStandardMaterial({color: '#26353a', roughness: .75});
  const orange = new THREE.MeshStandardMaterial({color: '#f27d2c', roughness: .7});
  const white = new THREE.MeshStandardMaterial({color: '#f5f2e7', roughness: .7});
  // Small trackside bollards and safety barriers follow the same route as the car.
  for (let i = 0; i < 40; i++) {
    const t = (i + .5) / 40, p = point(t), d = tangent(t);
    for (const side of [-1, 1]) {
      const offset = side * 4.35;
      const marker = new THREE.Group();
      marker.position.set(p.x - d.z * offset, .22, p.z + d.x * offset);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(.12, .18, .44, 8), i % 2 ? orange : white);
      base.castShadow = true; marker.add(base); scene.add(marker);
    }
  }
  // Floodlight masts placed around the outer edge of the diorama.
  for (const [x, z] of [[-39, -23], [39, -23], [-39, 23], [39, 23]]) {
    const group = new THREE.Group(); group.position.set(x, 0, z);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(.1, .18, 7, 8), pole);
    mast.position.y = 3.5; mast.castShadow = true; group.add(mast);
    const head = new THREE.Mesh(new THREE.BoxGeometry(1.3, .3, .45), dark);
    head.position.y = 7; group.add(head);
    const lamps = new THREE.Mesh(new THREE.BoxGeometry(1.1, .12, .06), white);
    lamps.position.set(0, 7, .24); group.add(lamps); scene.add(group);
  }
}
