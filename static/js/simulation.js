import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BOARD_SIZE, COPPER_HEIGHT, DEFECT_COLORS, to3D, sanitizeCurvePoints } from './constants.js';
import { buildExtrudedPCBMesh, createGlowParticleTexture } from './pcbmesh.js';

let activeSimCleanup = null;
let focusDefectFn = null;
let resetCameraFn = null;
let getCameraStateFn = null;

export function focusDefect(x2d, y2d) {
  if (focusDefectFn) focusDefectFn(x2d, y2d);
}

export function resetCamera() {
  if (resetCameraFn) resetCameraFn();
}

export function getCameraState() {
  return getCameraStateFn ? getCameraStateFn() : null;
}

export async function initPCBSimulation(
  container,
  imageUrl,
  manifest,
  isFixedMode = false,
  preservedCamState = null
) {
  if (activeSimCleanup) {
    activeSimCleanup();
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070b12);

  const camera = new THREE.PerspectiveCamera(
    42,
    container.clientWidth / container.clientHeight,
    0.1,
    100
  );

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    logarithmicDepthBuffer: true,
    powerPreference: 'high-performance',
  });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.maxPolarAngle = Math.PI / 2 - 0.04;

  if (preservedCamState) {
    camera.position.copy(preservedCamState.pos);
    controls.target.copy(preservedCamState.target);
  } else {
    camera.position.set(0, 8.0, 7.0);
    controls.target.set(0, 0, 0);
  }

  let flyTargetPos = null;
  let flyLookAt = null;

  controls.addEventListener('start', () => {
    flyTargetPos = null;
    flyLookAt = null;
  });

  focusDefectFn = (x2d, y2d) => {
    const pt = to3D(x2d, y2d, COPPER_HEIGHT);
    flyLookAt = pt.clone();
    flyTargetPos = new THREE.Vector3(pt.x, 2.8, pt.z + 2.3);
  };

  resetCameraFn = () => {
    flyLookAt = new THREE.Vector3(0, 0, 0);
    flyTargetPos = new THREE.Vector3(0, 8.0, 7.0);
  };

  getCameraStateFn = () => ({
    pos: camera.position.clone(),
    target: controls.target.clone(),
  });

  scene.add(new THREE.HemisphereLight(0xe0f2fe, 0x090d16, 0.95));

  const keyLight = new THREE.DirectionalLight(0xfffbeb, 1.9);
  keyLight.position.set(6, 12, 8);
  scene.add(keyLight);

  const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.85);
  rimLight.position.set(-7, 8, -6);
  scene.add(rimLight);

  const grid = new THREE.GridHelper(14, 28, 0x1e293b, 0x111827);
  grid.position.y = -0.26;
  scene.add(grid);

  const bezelGeo = new THREE.BoxGeometry(BOARD_SIZE + 0.16, 0.22, BOARD_SIZE + 0.16);
  const bezelMat = new THREE.MeshStandardMaterial({
    color: 0x052e16,
    roughness: 0.7,
    metalness: 0.1,
  });
  const bezelMesh = new THREE.Mesh(bezelGeo, bezelMat);
  bezelMesh.position.y = -0.12;
  scene.add(bezelMesh);

  const copperIsDark = manifest.copper_is_dark !== undefined ? manifest.copper_is_dark : true;
  const { mesh: pcbMesh, geo: pcbGeo, mat: pcbMat } = await buildExtrudedPCBMesh(
    imageUrl,
    copperIsDark,
    manifest.defects,
    isFixedMode
  );
  scene.add(pcbMesh);

  const defectMeshes = [];
  manifest.defects.forEach((defect) => {
    const [x1, y1, x2, y2] = defect.bbox_2d;
    const w = Math.max(((x2 - x1) / 640) * BOARD_SIZE, 0.34);
    const d = Math.max(((y2 - y1) / 640) * BOARD_SIZE, 0.34);
    const center = to3D((x1 + x2) / 2, (y1 + y2) / 2, COPPER_HEIGHT + 0.04);

    const color = isFixedMode ? 0x10b981 : DEFECT_COLORS[defect.class_name] || 0xff1133;

    const boxGeo = new THREE.BoxGeometry(w, 0.32, d);
    const boxMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: isFixedMode ? 0.14 : 0.22,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const box = new THREE.Mesh(boxGeo, boxMat);
    box.position.copy(center);
    box.renderOrder = 2;
    scene.add(box);

    const edges = new THREE.EdgesGeometry(boxGeo);
    const line = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      })
    );
    box.add(line);

    const ringGeo = new THREE.RingGeometry(0.1, Math.max(w, d) * 0.8, 36);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.set(center.x, COPPER_HEIGHT + 0.02, center.z);
    ring.renderOrder = 3;
    scene.add(ring);

    if (isFixedMode && defect.class_name === 'open' && defect.repaired_bridge_2d?.length >= 2) {
      const bridgePts3D = sanitizeCurvePoints(defect.repaired_bridge_2d, COPPER_HEIGHT + 0.01);
      if (bridgePts3D.length >= 2) {
        const bridgeCurve = new THREE.CatmullRomCurve3(bridgePts3D);
        const tubeGeo = new THREE.TubeGeometry(bridgeCurve, 16, 0.08, 10, false);
        const tubeMat = new THREE.MeshStandardMaterial({
          color: 0xfde047,
          metalness: 0.85,
          roughness: 0.2,
          emissive: 0x10b981,
          emissiveIntensity: 0.25,
        });
        scene.add(new THREE.Mesh(tubeGeo, tubeMat));
      }
    }

    defectMeshes.push({ box, ring, defect });
  });

  const tracesToSimulate =
    isFixedMode && manifest.fixed_traces && manifest.fixed_traces.length > 0
      ? manifest.fixed_traces
      : manifest.traces;

  const particleSystems = [];
  const particleSprite = createGlowParticleTexture();

  tracesToSimulate.forEach((trace) => {
    const activePts3D = sanitizeCurvePoints(trace.active_waypoints_2d, COPPER_HEIGHT + 0.03);
    if (activePts3D.length < 2) return;

    const curve = new THREE.CatmullRomCurve3(activePts3D);

    const activeColor = isFixedMode
      ? trace.status === 'repaired'
        ? 0x10b981
        : 0x00f5d4
      : trace.status === 'broken'
      ? 0xff2244
      : trace.status === 'shorted'
      ? 0x00ffff
      : trace.status === 'constricted'
      ? 0xff9900
      : trace.status === 'parasitic'
      ? 0xffdd00
      : 0x00f5d4;

    const curveGeo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(50));
    const curveLine = new THREE.Line(
      curveGeo,
      new THREE.LineBasicMaterial({
        color: activeColor,
        transparent: true,
        opacity: isFixedMode ? 0.55 : 0.4,
        depthWrite: false,
      })
    );
    curveLine.renderOrder = 1;
    scene.add(curveLine);

    if (!isFixedMode && trace.dead_waypoints_2d && trace.dead_waypoints_2d.length >= 2) {
      const deadPts3D = sanitizeCurvePoints(trace.dead_waypoints_2d, COPPER_HEIGHT + 0.02);
      if (deadPts3D.length >= 2) {
        const deadCurve = new THREE.CatmullRomCurve3(deadPts3D);
        const deadGeo = new THREE.BufferGeometry().setFromPoints(deadCurve.getPoints(36));
        const deadMat = new THREE.LineDashedMaterial({
          color: 0x991122,
          dashSize: 0.14,
          gapSize: 0.1,
          transparent: true,
          opacity: 0.75,
          depthWrite: false,
        });
        const deadLine = new THREE.Line(deadGeo, deadMat);
        deadLine.computeLineDistances();
        scene.add(deadLine);
      }
    }

    const count = 24;
    const positions = new Float32Array(count * 3);
    const progresses = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      progresses[i] = i / count;
    }

    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const pMat = new THREE.PointsMaterial({
      color: activeColor,
      map: particleSprite,
      size: 0.31,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const points = new THREE.Points(pGeo, pMat);
    points.renderOrder = 4;
    scene.add(points);

    particleSystems.push({
      points,
      curve,
      progresses,
      status: isFixedMode ? 'nominal' : trace.status,
    });
  });

  let animId;
  const clock = new THREE.Clock();

  function animate() {
    animId = requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    const elapsed = clock.getElapsedTime();

    if (flyTargetPos && flyLookAt) {
      camera.position.lerp(flyTargetPos, 0.08);
      controls.target.lerp(flyLookAt, 0.08);
      if (camera.position.distanceTo(flyTargetPos) < 0.08) {
        flyTargetPos = null;
        flyLookAt = null;
      }
    }

    defectMeshes.forEach(({ box, ring }) => {
      box.material.opacity = 0.14 + 0.1 * Math.sin(elapsed * 3.8);
      const cycle = (elapsed * 1.0) % 1.0;
      const scale = 0.9 + 0.5 * cycle;
      ring.scale.set(scale, scale, 1);
      ring.material.opacity = 0.65 * (1.0 - cycle);
    });

    particleSystems.forEach((sys) => {
      const posAttr = sys.points.geometry.attributes.position;

      for (let i = 0; i < sys.progresses.length; i++) {
        let p = sys.progresses[i];

        if (sys.status === 'broken') {
          const decel = Math.max(0.05, 1.0 - p);
          p += dt * 0.38 * decel;
          if (p > 0.96) p = 0.0;
        } else if (sys.status === 'constricted') {
          const inBottleneck = p > 0.35 && p < 0.7;
          p = (p + dt * (inBottleneck ? 0.11 : 0.34)) % 1.0;
        } else if (sys.status === 'shorted') {
          p = (p + dt * 0.52) % 1.0;
        } else {
          p = (p + dt * 0.35) % 1.0;
        }

        sys.progresses[i] = p;
        const pt = sys.curve.getPointAt(Math.min(0.999, Math.max(0.0, p)));

        if (sys.status === 'shorted' && p > 0.4 && p < 0.6) {
          pt.x += Math.sin(elapsed * 26 + i) * 0.035;
          pt.y += Math.abs(Math.cos(elapsed * 26 + i)) * 0.04;
        }

        posAttr.setXYZ(i, pt.x, pt.y, pt.z);
      }
      posAttr.needsUpdate = true;
    });

    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  const onResize = () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  };
  window.addEventListener('resize', onResize);

  activeSimCleanup = () => {
    cancelAnimationFrame(animId);
    window.removeEventListener('resize', onResize);
    pcbGeo.dispose();
    pcbMat.dispose();
    particleSprite.dispose();
    renderer.dispose();
    if (renderer.domElement.parentNode === container) {
      container.removeChild(renderer.domElement);
    }
  };
}