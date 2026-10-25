import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const API_URL =
  window.location.port === '5173' ? 'http://localhost:8000/analyze' : '/analyze';
const BOARD_SIZE = 10;
const COPPER_HEIGHT = 0.16;

const DEFECT_COLORS = {
  open: 0xff1133,
  short: 0x00ffff,
  mousebite: 0xff8800,
  spur: 0xffdd00,
  pinhole: 0xff5500,
  spurious_copper: 0xaa00ff,
};

const DEFECT_HEX_CSS = {
  open: '#ff1133',
  short: '#00ffff',
  mousebite: '#ff8800',
  spur: '#ffdd00',
  pinhole: '#ff5500',
  spurious_copper: '#aa00ff',
};

const REMEDIATION_GUIDE = {
  open: {
    actionLabel: 'SOLDER JUMPER BRIDGE APPLIED',
    rework: 'Conductive 30AWG silver-solder bridge synthesized across the open gap, restoring continuous current flow.',
    process: 'Inspect photomask for dust/scratches and reduce acid etchant dwell time.',
  },
  short: {
    actionLabel: 'SHORT BRIDGE LASER-SEVERED',
    rework: 'Unintended copper bridge ablated down to the FR-4 substrate, isolating the two parallel nets.',
    process: 'Increase UV exposure energy or developer concentration.',
  },
  mousebite: {
    actionLabel: 'COPPER FILLET REINFORCED',
    rework: 'Necked trace edge filled back to full cross-sectional width, eliminating I²R thermal bottleneck.',
    process: 'Check photoresist adhesion and roller lamination pressure.',
  },
  spur: {
    actionLabel: 'PARASITIC SPUR ETCHED OFF',
    rework: 'Protruding copper spike shaved off to restore nominal trace-to-trace clearance.',
    process: 'Filter developer bath to remove redeposited resist particulates.',
  },
  pinhole: {
    actionLabel: 'PINHOLE VOID FILLED',
    rework: 'Internal trace void filled with conductive copper/solder paste to restore current capacity.',
    process: 'Degass plating bath and clean copper laminate prior to lamination.',
  },
  spurious_copper: {
    actionLabel: 'ISOLATED ISLAND MILLED OFF',
    rework: 'Stray copper island removed from FR-4 substrate, eliminating parasitic capacitance.',
    process: 'Replenish spent etchant solution and increase spray nozzle pressure.',
  },
};

let activeSimCleanup = null;
let focusDefect3D = null;
let resetCamera3D = null;
let getCameraState3D = null;

let currentImageUrl = null;
let currentManifest = null;
let isFixedSimulationMode = false;

function to3D(x2d, y2d, height = COPPER_HEIGHT + 0.03) {
  return new THREE.Vector3(
    (x2d / 640 - 0.5) * BOARD_SIZE,
    height,
    (y2d / 640 - 0.5) * BOARD_SIZE
  );
}

/**
 * Deduplicates consecutive close points so CatmullRomCurve3 never divides by zero or produces NaN.
 */
function sanitizeCurvePoints(pts2d, height) {
  if (!pts2d || pts2d.length === 0) return [];
  const clean3D = [to3D(pts2d[0][0], pts2d[0][1], height)];
  for (let i = 1; i < pts2d.length; i++) {
    const candidate = to3D(pts2d[i][0], pts2d[i][1], height);
    if (candidate.distanceToSquared(clean3D[clean3D.length - 1]) > 0.0004) {
      clean3D.push(candidate);
    }
  }
  return clean3D;
}

// ============================================================================
// 2D-TO-3D SELF-CORRECTING COPPER SURGERY ENGINE
// ============================================================================
function apply2DCopperRepairs(ctx, repairMaskCtx, gridRes, defects) {
  const scale = gridRes / 640.0;

  defects.forEach((d) => {
    const [x1, y1, x2, y2] = d.bbox_2d.map((v) => v * scale);
    const cx = d.center_2d[0] * scale;
    const cy = d.center_2d[1] * scale;
    const w = x2 - x1;
    const h = y2 - y1;

    if (d.class_name === 'open') {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(12 * scale, 8);
      ctx.lineCap = 'round';
      ctx.beginPath();
      if (d.repaired_bridge_2d && d.repaired_bridge_2d.length >= 2) {
        const pts = d.repaired_bridge_2d.map(([px, py]) => [px * scale, py * scale]);
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      } else {
        ctx.moveTo(x1 - 6 * scale, cy);
        ctx.lineTo(x2 + 6 * scale, cy);
      }
      ctx.stroke();

      repairMaskCtx.strokeStyle = '#ffffff';
      repairMaskCtx.lineWidth = Math.max(14 * scale, 9);
      repairMaskCtx.lineCap = 'round';
      repairMaskCtx.beginPath();
      if (d.repaired_bridge_2d && d.repaired_bridge_2d.length >= 2) {
        const pts = d.repaired_bridge_2d.map(([px, py]) => [px * scale, py * scale]);
        repairMaskCtx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) repairMaskCtx.lineTo(pts[i][0], pts[i][1]);
      } else {
        repairMaskCtx.moveTo(x1 - 6 * scale, cy);
        repairMaskCtx.lineTo(x2 + 6 * scale, cy);
      }
      repairMaskCtx.stroke();
    } else if (d.class_name === 'mousebite' || d.class_name === 'pinhole') {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(w, h) * 0.36, 0, Math.PI * 2);
      ctx.fill();

      repairMaskCtx.fillStyle = '#ffffff';
      repairMaskCtx.beginPath();
      repairMaskCtx.arc(cx, cy, Math.max(w, h) * 0.4, 0, Math.PI * 2);
      repairMaskCtx.fill();
    } else if (d.class_name === 'short') {
      ctx.fillStyle = '#000000';
      const cutThickness = Math.max(16 * scale, 9);
      ctx.fillRect(x1 + 2, cy - cutThickness / 2, w - 4, cutThickness);

      repairMaskCtx.fillStyle = '#ffffff';
      repairMaskCtx.fillRect(x1 + 2, cy - cutThickness / 2, w - 4, cutThickness);
    } else if (d.class_name === 'spur') {
      ctx.fillStyle = '#000000';
      ctx.fillRect(x1 + 2, y1 + 2, w - 4, h * 0.65);

      repairMaskCtx.fillStyle = '#ffffff';
      repairMaskCtx.fillRect(x1 + 2, y1 + 2, w - 4, h * 0.65);
    } else if (d.class_name === 'spurious_copper') {
      ctx.fillStyle = '#000000';
      ctx.fillRect(x1 + 2, y1 + 2, w - 4, h - 4);

      repairMaskCtx.fillStyle = '#ffffff';
      repairMaskCtx.fillRect(x1 + 2, y1 + 2, w - 4, h - 4);
    }
  });
}

function buildExtrudedPCBMesh(imageUrl, copperIsDark = true, defects = [], isFixedMode = false) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const SEGMENTS = 420;
      const gridRes = SEGMENTS + 1;

      const rawCanvas = document.createElement('canvas');
      rawCanvas.width = gridRes;
      rawCanvas.height = gridRes;
      const rCtx = rawCanvas.getContext('2d');
      rCtx.drawImage(img, 0, 0, gridRes, gridRes);

      const imgData = rCtx.getImageData(0, 0, gridRes, gridRes);
      const px = imgData.data;

      for (let i = 0; i < px.length; i += 4) {
        const lum = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
        const isCopper = copperIsDark ? lum < 128 : lum > 127;
        const val = isCopper ? 255 : 0;
        px[i] = val;
        px[i + 1] = val;
        px[i + 2] = val;
        px[i + 3] = 255;
      }
      rCtx.putImageData(imgData, 0, 0);

      const repairMaskCanvas = document.createElement('canvas');
      repairMaskCanvas.width = gridRes;
      repairMaskCanvas.height = gridRes;
      const repairMaskCtx = repairMaskCanvas.getContext('2d');
      repairMaskCtx.fillStyle = '#000000';
      repairMaskCtx.fillRect(0, 0, gridRes, gridRes);

      if (isFixedMode && defects && defects.length > 0) {
        apply2DCopperRepairs(rCtx, repairMaskCtx, gridRes, defects);
      }

      const repairPixels = repairMaskCtx.getImageData(0, 0, gridRes, gridRes).data;

      const smoothCanvas = document.createElement('canvas');
      smoothCanvas.width = gridRes;
      smoothCanvas.height = gridRes;
      const sCtx = smoothCanvas.getContext('2d');
      sCtx.filter = 'blur(0.9px)';
      sCtx.drawImage(rawCanvas, 0, 0);
      const heightPixels = sCtx.getImageData(0, 0, gridRes, gridRes).data;

      const geo = new THREE.PlaneGeometry(BOARD_SIZE, BOARD_SIZE, SEGMENTS, SEGMENTS);
      geo.rotateX(-Math.PI / 2);

      const posAttr = geo.attributes.position;
      const vertexCount = posAttr.count;
      const colors = new Float32Array(vertexCount * 3);

      const colSubstrate = new THREE.Color(0x073b1e);
      const colWall = new THREE.Color(0x783f16);
      const colCopper = new THREE.Color(0xe59849);
      const colSolderPatch = new THREE.Color(0xfde047);
      const tempCol = new THREE.Color();

      for (let i = 0; i < vertexCount; i++) {
        const normalizedH = heightPixels[i * 4] / 255.0;
        const isRepairedZone = repairPixels[i * 4] > 100;
        const shapedH = Math.pow(normalizedH, 0.75);
        posAttr.setY(i, shapedH * COPPER_HEIGHT);

        if (shapedH < 0.12) {
          tempCol.copy(colSubstrate);
        } else if (isRepairedZone && isFixedMode) {
          tempCol.copy(colSolderPatch);
        } else if (shapedH < 0.72) {
          const t = (shapedH - 0.12) / 0.6;
          tempCol.lerpColors(colWall, colCopper, t);
        } else {
          tempCol.copy(colCopper);
        }

        colors[i * 3] = tempCol.r;
        colors[i * 3 + 1] = tempCol.g;
        colors[i * 3 + 2] = tempCol.b;
      }

      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geo.computeVertexNormals();

      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        metalness: 0.6,
        roughness: 0.3,
      });

      const mesh = new THREE.Mesh(geo, mat);
      resolve({ mesh, geo, mat });
    };
    img.src = imageUrl;
  });
}

function createGlowParticleTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');

  const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
  grad.addColorStop(0.35, 'rgba(255, 255, 255, 0.85)');
  grad.addColorStop(0.7, 'rgba(255, 255, 255, 0.2)');
  grad.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

// ============================================================================
// CORE THREE.JS 3D SIMULATION ENGINE
// ============================================================================
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

  focusDefect3D = (x2d, y2d) => {
    const pt = to3D(x2d, y2d, COPPER_HEIGHT);
    flyLookAt = pt.clone();
    flyTargetPos = new THREE.Vector3(pt.x, 2.8, pt.z + 2.3);
  };

  resetCamera3D = () => {
    flyLookAt = new THREE.Vector3(0, 0, 0);
    flyTargetPos = new THREE.Vector3(0, 8.0, 7.0);
  };

  getCameraState3D = () => ({
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

// ============================================================================
// UI CONTROLLER (WITH SELF-HEALING DOM FALLBACKS)
// ============================================================================
const uploadZone = document.getElementById('upload-zone');
const fileInput = document.getElementById('file-input');
const demoBtn = document.getElementById('demo-btn');
const resetCamBtn = document.getElementById('reset-cam-btn');
const statusBar = document.getElementById('status-bar');
const defectListEl = document.getElementById('defect-list');
const viewportEl = document.getElementById('viewport');

// Auto-create #self-correct-btn and #mode-banner if an older index.html was cached
let selfCorrectBtn = document.getElementById('self-correct-btn');
if (!selfCorrectBtn && uploadZone && uploadZone.parentNode) {
  selfCorrectBtn = document.createElement('button');
  selfCorrectBtn.id = 'self-correct-btn';
  selfCorrectBtn.textContent = '✨ Self-Correct Circuit (Fix All Flaws)';
  selfCorrectBtn.style.cssText =
    'width:100%; margin-top:9px; padding:10px; background:#10b981; color:#fff; font-weight:700; border-radius:8px; border:none; cursor:pointer;';
  uploadZone.parentNode.insertBefore(selfCorrectBtn, uploadZone.nextSibling);
}

let modeBanner = document.getElementById('mode-banner');
if (!modeBanner && viewportEl) {
  modeBanner = document.createElement('div');
  modeBanner.id = 'mode-banner';
  modeBanner.textContent = '🚨 DEFECTIVE CIRCUIT SIMULATION (ERRORS ACTIVE)';
  modeBanner.style.cssText =
    'position:absolute; top:16px; left:20px; padding:9px 16px; border-radius:8px; font-size:0.82rem; font-weight:700; background:rgba(220,38,38,0.25); border:1px solid #ff2244; color:#fecdd3; z-index:5;';
  viewportEl.appendChild(modeBanner);
}

if (uploadZone) {
  uploadZone.addEventListener('click', () => fileInput && fileInput.click());
  uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.style.borderColor = '#00e5ff';
  });
  uploadZone.addEventListener('dragleave', () => {
    uploadZone.style.borderColor = 'rgba(0, 229, 255, 0.4)';
  });
  uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length > 0) {
      handleFileUpload(e.dataTransfer.files[0]);
    }
  });
}

if (fileInput) {
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFileUpload(e.target.files[0]);
    }
  });
}

if (resetCamBtn) {
  resetCamBtn.addEventListener('click', () => {
    if (resetCamera3D) resetCamera3D();
  });
}

if (selfCorrectBtn) {
  selfCorrectBtn.addEventListener('click', async () => {
    if (!currentImageUrl || !currentManifest) return;

    const savedCam = getCameraState3D ? getCameraState3D() : null;
    isFixedSimulationMode = !isFixedSimulationMode;
    updateModeUI();
    renderDefectListUI(currentManifest.defects, isFixedSimulationMode);
    await initPCBSimulation(
      viewportEl,
      currentImageUrl,
      currentManifest,
      isFixedSimulationMode,
      savedCam
    );
  });
}

function updateModeUI() {
  if (!selfCorrectBtn || !modeBanner || !currentManifest) return;
  if (isFixedSimulationMode) {
    selfCorrectBtn.textContent = 'View Original Defective Circuit';
    selfCorrectBtn.classList.add('is-fixed');
    modeBanner.textContent =
      'SELF-CORRECTED CIRCUIT SIMULATION (ALL FLAWS REPAIRED — NOMINAL FLOW)';
    modeBanner.classList.add('fixed-mode');
    statusBar.textContent = `Self-Correction Active: All ${currentManifest.defects.length} flaws repaired in 3D.`;
  } else {
    selfCorrectBtn.textContent = '✨ Self-Correct Circuit (Fix All Flaws)';
    selfCorrectBtn.classList.remove('is-fixed');
    modeBanner.textContent = 'DEFECTIVE CIRCUIT SIMULATION (ERRORS ACTIVE)';
    modeBanner.classList.remove('fixed-mode');
    statusBar.textContent = `Defective Mode: ${currentManifest.defects.length} flaws interrupting current.`;
  }
}

async function handleFileUpload(file) {
  statusBar.textContent = `Analyzing "${file.name}" via POST /analyze...`;
  currentImageUrl = URL.createObjectURL(file);
  isFixedSimulationMode = false;

  const formData = new FormData();
  formData.append('file', file);

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }

    currentManifest = await response.json();
    updateModeUI();
    renderDefectListUI(currentManifest.defects, false);
    await initPCBSimulation(viewportEl, currentImageUrl, currentManifest, false);
  } catch (err) {
    statusBar.textContent = `Backend offline (${err.message}). Using local self-correcting manifest.`;
    currentManifest = createLocalPreviewManifest();
    updateModeUI();
    renderDefectListUI(currentManifest.defects, false);
    await initPCBSimulation(viewportEl, currentImageUrl, currentManifest, false);
  }
}

function renderDefectListUI(defects, isFixed = false) {
  if (!defectListEl) return;
  defectListEl.innerHTML = '';
  if (!defects || defects.length === 0) {
    defectListEl.innerHTML =
      '<div style="font-size:0.78rem; color:#94a3b8;">No defects detected on this board.</div>';
    return;
  }

  defects.forEach((d) => {
    const [x1, y1, x2, y2] = d.bbox_2d;
    const areaPx = (x2 - x1) * (y2 - y1);
    const severity = areaPx > 900 ? 'CRITICAL' : areaPx > 400 ? 'MODERATE' : 'MINOR';
    const guide = REMEDIATION_GUIDE[d.class_name] || REMEDIATION_GUIDE.open;

    const borderColor = isFixed ? '#10b981' : DEFECT_HEX_CSS[d.class_name] || '#ff1133';
    const badgeText = isFixed ? `✅ FIXED (${guide.actionLabel})` : d.simulation_effect;
    const badgeColor = isFixed ? '#10b981' : DEFECT_HEX_CSS[d.class_name];

    const item = document.createElement('div');
    item.className = 'defect-item';
    item.style.borderLeftColor = borderColor;
    item.innerHTML = `
      <div class="defect-item-header">
        <span>#${d.class_id} ${d.class_name.replace('_', ' ')} (${severity})</span>
        <span style="color:${badgeColor}">${badgeText}</span>
      </div>
      <div class="defect-item-sub">
        Location: (${d.center_2d[0]}, ${d.center_2d[1]}) &bull; Click to inspect 3D repair
      </div>
      <div class="fix-panel" style="display:${isFixed ? 'block' : 'none'}; margin-top:7px; padding:8px; background:rgba(0,0,0,0.35); border-radius:6px; font-size:0.72rem; line-height:1.45; color:#e2e8f0;">
        <div><strong style="color:#10b981;">Self-Correction Applied:</strong> ${guide.rework}</div>
        <div style="margin-top:4px;"><strong style="color:#a78bfa;">Root-Cause Fix:</strong> ${guide.process}</div>
      </div>
    `;

    item.addEventListener('click', () => {
      const panel = item.querySelector('.fix-panel');
      if (panel) {
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      }
      if (focusDefect3D) focusDefect3D(d.center_2d[0], d.center_2d[1]);
    });

    defectListEl.appendChild(item);
  });
}

// ============================================================================
// 6-CLASS SYNTHETIC 640x640 DEEPPCB GENERATOR FOR INSTANT TESTING
// ============================================================================
function generateSyntheticDeepPCBBlob() {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 640;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 640, 640);

    ctx.strokeStyle = '#000000';
    ctx.fillStyle = '#000000';
    ctx.lineWidth = 16;
    ctx.lineCap = 'square';
    ctx.lineJoin = 'round';

    // Trace 1 (y=110): #1 OPEN break at (312, 110)
    ctx.beginPath();
    ctx.moveTo(80, 110);
    ctx.lineTo(288, 110);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(336, 110);
    ctx.lineTo(560, 110);
    ctx.stroke();

    // Isolated #6 SPURIOUS COPPER island at (160, 170)
    ctx.beginPath();
    ctx.arc(160, 170, 9, 0, Math.PI * 2);
    ctx.fill();

    // Trace 2 (y=230): #3 MOUSEBITE nick at (250, 230) + #5 PINHOLE void at (430, 230)
    ctx.beginPath();
    ctx.moveTo(80, 230);
    ctx.lineTo(560, 230);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(240, 220, 20, 11);
    ctx.beginPath();
    ctx.arc(430, 230, 4, 0, Math.PI * 2);
    ctx.fill();

    // Trace 3 (y=360): #4 SPUR spike protruding upward at (300, 344)
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.moveTo(80, 360);
    ctx.lineTo(560, 360);
    ctx.stroke();
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(300, 360);
    ctx.lineTo(300, 328);
    ctx.stroke();

    // Trace 4 (y=460) & Trace 5 (y=530): #2 SHORT bridge at (420, 495)
    ctx.lineWidth = 16;
    ctx.beginPath();
    ctx.moveTo(80, 460);
    ctx.lineTo(560, 460);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(80, 530);
    ctx.lineTo(560, 530);
    ctx.stroke();

    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(420, 460);
    ctx.lineTo(420, 530);
    ctx.stroke();

    [110, 230, 360, 460, 530].forEach((y) => {
      ctx.beginPath();
      ctx.arc(80, y, 22, 0, Math.PI * 2);
      ctx.arc(560, y, 22, 0, Math.PI * 2);
      ctx.fill();
    });

    canvas.toBlob((blob) => {
      resolve(new File([blob], 'synthetic_deeppcb_all6.png', { type: 'image/png' }));
    }, 'image/png');
  });
}

function createLocalPreviewManifest() {
  return {
    image_size: [640, 640],
    copper_is_dark: true,
    defects: [
      {
        id: 'flaw_1',
        class_id: 1,
        class_name: 'open',
        bbox_2d: [282, 90, 342, 130],
        center_2d: [312, 110],
        simulation_effect: 'STOP_CURRENT',
        repair_action: 'SOLDER_JUMPER_BRIDGE',
        repaired_bridge_2d: [[287, 110], [312, 110], [337, 110]],
      },
      {
        id: 'flaw_2',
        class_id: 2,
        class_name: 'short',
        bbox_2d: [400, 456, 440, 534],
        center_2d: [420, 495],
        simulation_effect: 'ARC_SHORT',
        repair_action: 'LASER_SEVER_BRIDGE',
        repaired_bridge_2d: [[400, 495], [420, 495], [440, 495]],
      },
      {
        id: 'flaw_3',
        class_id: 3,
        class_name: 'mousebite',
        bbox_2d: [227, 208, 267, 244],
        center_2d: [247, 226],
        simulation_effect: 'BOTTLENECK_HEAT',
        repair_action: 'SOLDER_FILLET_REINFORCE',
        repaired_bridge_2d: [[227, 226], [247, 226], [267, 226]],
      },
      {
        id: 'flaw_4',
        class_id: 4,
        class_name: 'spur',
        bbox_2d: [282, 322, 318, 366],
        center_2d: [300, 344],
        simulation_effect: 'PARASITIC_BOUNCE',
        repair_action: 'ETCH_REMOVE_SPUR',
        repaired_bridge_2d: [[282, 344], [300, 344], [318, 344]],
      },
      {
        id: 'flaw_5',
        class_id: 5,
        class_name: 'pinhole',
        bbox_2d: [412, 212, 448, 248],
        center_2d: [430, 230],
        simulation_effect: 'BOTTLENECK_HEAT',
        repair_action: 'COPPER_FILL_VOID',
        repaired_bridge_2d: [[412, 230], [430, 230], [448, 230]],
      },
      {
        id: 'flaw_6',
        class_id: 6,
        class_name: 'spurious_copper',
        bbox_2d: [142, 152, 178, 188],
        center_2d: [160, 170],
        simulation_effect: 'PARASITIC_BOUNCE',
        repair_action: 'MILL_ISOLATED_COPPER',
        repaired_bridge_2d: [[142, 170], [160, 170], [178, 170]],
      },
    ],
    traces: [
      {
        trace_id: 'net_01',
        status: 'broken',
        blocking_defect_id: 'flaw_1',
        active_waypoints_2d: [[80, 110], [180, 110], [287, 110]],
        dead_waypoints_2d: [[337, 110], [450, 110], [560, 110]],
      },
      {
        trace_id: 'net_02',
        status: 'constricted',
        blocking_defect_id: 'flaw_3',
        active_waypoints_2d: [[80, 230], [200, 230], [320, 230], [440, 230], [560, 230]],
        dead_waypoints_2d: [],
      },
      {
        trace_id: 'net_03',
        status: 'parasitic',
        blocking_defect_id: 'flaw_4',
        active_waypoints_2d: [[80, 360], [200, 360], [300, 360], [440, 360], [560, 360]],
        dead_waypoints_2d: [],
      },
      {
        trace_id: 'net_04',
        status: 'shorted',
        blocking_defect_id: 'flaw_2',
        active_waypoints_2d: [[80, 460], [250, 460], [420, 460], [560, 460]],
        dead_waypoints_2d: [],
      },
      {
        trace_id: 'net_05',
        status: 'shorted',
        blocking_defect_id: 'flaw_2',
        active_waypoints_2d: [[80, 530], [250, 530], [420, 530], [560, 530]],
        dead_waypoints_2d: [],
      },
      {
        trace_id: 'short_bridge_flaw_2',
        status: 'shorted',
        blocking_defect_id: 'flaw_2',
        active_waypoints_2d: [[420, 460], [420, 495], [420, 530]],
        dead_waypoints_2d: [],
      },
    ],
    fixed_traces: [
      {
        trace_id: 'net_01',
        status: 'repaired',
        blocking_defect_id: 'flaw_1',
        active_waypoints_2d: [[80, 110], [180, 110], [287, 110], [312, 110], [337, 110], [450, 110], [560, 110]],
        dead_waypoints_2d: [],
      },
      {
        trace_id: 'net_02',
        status: 'repaired',
        blocking_defect_id: 'flaw_3',
        active_waypoints_2d: [[80, 230], [200, 230], [320, 230], [440, 230], [560, 230]],
        dead_waypoints_2d: [],
      },
      {
        trace_id: 'net_03',
        status: 'repaired',
        blocking_defect_id: 'flaw_4',
        active_waypoints_2d: [[80, 360], [200, 360], [300, 360], [440, 360], [560, 360]],
        dead_waypoints_2d: [],
      },
      {
        trace_id: 'net_04',
        status: 'repaired',
        blocking_defect_id: 'flaw_2',
        active_waypoints_2d: [[80, 460], [250, 460], [420, 460], [560, 460]],
        dead_waypoints_2d: [],
      },
      {
        trace_id: 'net_05',
        status: 'repaired',
        blocking_defect_id: 'flaw_2',
        active_waypoints_2d: [[80, 530], [250, 530], [420, 530], [560, 530]],
        dead_waypoints_2d: [],
      },
    ],
  };
}

if (demoBtn) {
  demoBtn.addEventListener('click', async () => {
    const demoFile = await generateSyntheticDeepPCBBlob();
    handleFileUpload(demoFile);
  });
  demoBtn.click();
}