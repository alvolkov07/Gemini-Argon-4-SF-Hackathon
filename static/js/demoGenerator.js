export function generateSyntheticDeepPCBBlob() {
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

export function createLocalPreviewManifest() {
  return {
    image_size: [640, 640],
    copper_is_dark: true,
    verification: {
      verified: true,
      iterations_run: 1,
      initial_defect_count: 6,
      residual_defect_count: 0,
      log: ['Iter 1: 0 residual flaws. Verification PASSED.'],
    },
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