// Minimal three.js viewer for the generated relief mesh.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { MeshData } from './model';

export class Viewer3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.1, 5000);
  private controls: OrbitControls;
  private group = new THREE.Group();
  private el: HTMLElement;

  constructor(el: HTMLElement) {
    this.el = el;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    el.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color('#1d2a22');
    this.camera.up.set(0, 0, 1);
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#445544', 1.2));
    const sun = new THREE.DirectionalLight('#ffffff', 1.5);
    sun.position.set(-1, -2, 3);
    this.scene.add(sun);
    this.scene.add(this.group);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener('change', () => this.render());
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
  }

  private resize() {
    const w = this.el.clientWidth;
    const h = Math.round(w * 0.65);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  private render() {
    this.renderer.render(this.scene, this.camera);
  }

  /** Show one or more parts side by side along X, in print orientation. */
  show(meshes: MeshData[]) {
    for (const c of [...this.group.children] as THREE.Mesh[]) {
      this.group.remove(c);
      c.geometry.dispose();
    }
    const material = new THREE.MeshStandardMaterial({ color: '#d9a066', roughness: 0.6, metalness: 0.1 });
    let x = 0;
    for (const data of meshes) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
      geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
      // Flat shading: duplicate vertices so each face has its own normal.
      const flat = geo.toNonIndexed();
      geo.dispose();
      flat.computeVertexNormals();
      flat.computeBoundingBox();
      const b = flat.boundingBox!;
      const mesh = new THREE.Mesh(flat, material);
      mesh.position.x = x - b.min.x;
      x += b.max.x - b.min.x + 5; // 5 mm gap between parts
      this.group.add(mesh);
    }
    const box = new THREE.Box3().setFromObject(this.group);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    this.controls.target.copy(center);
    this.camera.position.set(center.x + size * 0.3, center.y - size * 0.9, center.z + size * 0.8);
    this.camera.near = size / 100;
    this.camera.far = size * 10;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.render();
  }
}
