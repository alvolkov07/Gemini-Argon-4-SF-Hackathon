import * as THREE from 'three';

export const API_URL =
  window.location.port === '5173' ? 'http://localhost:8000/analyze' : '/analyze';
export const BOARD_SIZE = 10;
export const COPPER_HEIGHT = 0.16;

export const DEFECT_COLORS = {
  open: 0xff1133,
  short: 0x00ffff,
  mousebite: 0xff8800,
  spur: 0xffdd00,
  pinhole: 0xff5500,
  spurious_copper: 0xaa00ff,
};

export const DEFECT_HEX_CSS = {
  open: '#ff1133',
  short: '#00ffff',
  mousebite: '#ff8800',
  spur: '#ffdd00',
  pinhole: '#ff5500',
  spurious_copper: '#aa00ff',
};

export const REMEDIATION_GUIDE = {
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

export function to3D(x2d, y2d, height = COPPER_HEIGHT + 0.03) {
  return new THREE.Vector3(
    (x2d / 640 - 0.5) * BOARD_SIZE,
    height,
    (y2d / 640 - 0.5) * BOARD_SIZE
  );
}

export function sanitizeCurvePoints(pts2d, height) {
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