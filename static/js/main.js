import { API_URL, DEFECT_HEX_CSS, REMEDIATION_GUIDE } from './constants.js';
import { initPCBSimulation, focusDefect, resetCamera, getCameraState } from './simulation.js';
import { generateSyntheticDeepPCBBlob, createLocalPreviewManifest } from './demoGenerator.js';

let currentImageUrl = null;
let currentManifest = null;
let isFixedSimulationMode = false;

const uploadZone = document.getElementById('upload-zone');
const fileInput = document.getElementById('file-input');
const selfCorrectBtn = document.getElementById('self-correct-btn');
const demoBtn = document.getElementById('demo-btn');
const resetCamBtn = document.getElementById('reset-cam-btn');
const statusBar = document.getElementById('status-bar');
const defectListEl = document.getElementById('defect-list');
const viewportEl = document.getElementById('viewport');
const modeBanner = document.getElementById('mode-banner');

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
  resetCamBtn.addEventListener('click', () => resetCamera());
}

if (selfCorrectBtn) {
  selfCorrectBtn.addEventListener('click', async () => {
    if (!currentImageUrl || !currentManifest) return;

    const savedCam = getCameraState();
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
  const v = currentManifest.verification;
  const verifySummary = v
    ? `Verified (${v.iterations_run} iter): ${v.initial_defect_count} → ${v.residual_defect_count} residual flaws`
    : `All ${currentManifest.defects.length} flaws repaired`;

  if (isFixedSimulationMode) {
    selfCorrectBtn.textContent = '🚨 View Original Defective Circuit';
    selfCorrectBtn.classList.add('is-fixed');
    modeBanner.textContent = `✅ SELF-CORRECTED CIRCUIT (${verifySummary.toUpperCase()})`;
    modeBanner.classList.add('fixed-mode');
    statusBar.textContent = v && v.log.length ? v.log[v.log.length - 1] : verifySummary;
  } else {
    selfCorrectBtn.textContent = '✨ Self-Correct Circuit (Fix All Flaws)';
    selfCorrectBtn.classList.remove('is-fixed');
    modeBanner.textContent = '🚨 DEFECTIVE CIRCUIT SIMULATION (ERRORS ACTIVE)';
    modeBanner.classList.remove('fixed-mode');
    statusBar.textContent = `Defective Mode: ${currentManifest.defects.length} flaws (${verifySummary}).`;
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
      focusDefect(d.center_2d[0], d.center_2d[1]);
    });

    defectListEl.appendChild(item);
  });
}

if (demoBtn) {
  demoBtn.addEventListener('click', async () => {
    const demoFile = await generateSyntheticDeepPCBBlob();
    handleFileUpload(demoFile);
  });
  demoBtn.click();
}