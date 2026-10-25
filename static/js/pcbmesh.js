import * as THREE from 'three';
import { BOARD_SIZE, COPPER_HEIGHT } from './constants.js';

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

export function buildExtrudedPCBMesh(imageUrl, copperIsDark = true, defects = [], isFixedMode = false) {
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

export function createGlowParticleTexture() {
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