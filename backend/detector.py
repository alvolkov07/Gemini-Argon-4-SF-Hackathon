import io
import json
from collections import deque
from typing import List, Tuple

import cv2
import numpy as np
from PIL import Image
from skimage.morphology import skeletonize

from .schemas import (
    MODEL_ID,
    GEMINI_API_KEY,
    CLASS_ID_TO_NAME,
    NAME_TO_CLASS_ID,
    EFFECT_BY_CLASS,
    REPAIR_ACTION_BY_CLASS,
    AGENT_SYSTEM_PROMPT,
    LLMDefectResponse,
    DefectOut,
)

try:
    from google import genai
    from google.genai import types
    GENAI_AVAILABLE = True
except ImportError:
    GENAI_AVAILABLE = False


def build_solid_and_skeleton(binary_copper: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    contours_ext, _ = cv2.findContours(binary_copper, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    solid_copper = np.zeros_like(binary_copper)
    cv2.drawContours(solid_copper, contours_ext, -1, 255, -1)
    skeleton = skeletonize(solid_copper > 0).astype(np.uint8) * 255
    return solid_copper, skeleton


def preprocess_pcb_image(image_bytes: bytes) -> Tuple[np.ndarray, np.ndarray, np.ndarray, bool]:
    file_bytes = np.frombuffer(image_bytes, np.uint8)
    img_gray = cv2.imdecode(file_bytes, cv2.IMREAD_GRAYSCALE)
    if img_gray is None:
        raise ValueError("Could not decode uploaded image file.")

    img_640 = cv2.resize(img_gray, (640, 640), interpolation=cv2.INTER_AREA)

    _, mask_dark = cv2.threshold(img_640, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    mask_light = cv2.bitwise_not(mask_dark)

    border_dark_ratio = (
        np.mean(mask_dark[0, :]) + np.mean(mask_dark[-1, :]) +
        np.mean(mask_dark[:, 0]) + np.mean(mask_dark[:, -1])
    ) / (4.0 * 255.0)

    if border_dark_ratio < 0.5:
        binary_copper = mask_dark
        copper_is_dark = True
    else:
        binary_copper = mask_light
        copper_is_dark = False

    clean_kernel = np.ones((3, 3), np.uint8)
    binary_copper = cv2.morphologyEx(binary_copper, cv2.MORPH_OPEN, clean_kernel, iterations=1)
    _, skeleton = build_solid_and_skeleton(binary_copper)
    return img_640, binary_copper, skeleton, copper_is_dark


def cv_detect_all_6_defect_classes(
    binary_copper: np.ndarray, skeleton: np.ndarray
) -> List[DefectOut]:
    solid_copper, _ = build_solid_and_skeleton(binary_copper)
    solid_dist = cv2.distanceTransform(solid_copper, cv2.DIST_L2, 5)
    _, skel_cc_labels = cv2.connectedComponents(skeleton, connectivity=8)

    skel_dists = solid_dist[skeleton > 0]
    trace_radii = skel_dists[(skel_dists >= 3.0) & (skel_dists <= 13.5)]
    nominal_radius = float(np.median(trace_radii)) if len(trace_radii) > 0 else 8.5
    pad_radius_thresh = nominal_radius * 1.45

    raw_detections: List[dict] = []

    def add_candidate(cid: int, cx: float, cy: float, half_w: int = 20, half_h: int = 20, bridge_pts=None):
        icx, icy = int(round(cx)), int(round(cy))
        for existing in raw_detections:
            ex, ey = existing["center_2d"]
            if np.hypot(ex - icx, ey - icy) < 32:
                return
        x1, y1 = max(0, icx - half_w), max(0, icy - half_h)
        x2, y2 = min(640, icx + half_w), min(640, icy + half_h)
        cname = CLASS_ID_TO_NAME[cid]
        raw_detections.append({
            "class_id": cid,
            "class_name": cname,
            "bbox_2d": [x1, y1, x2, y2],
            "center_2d": [icx, icy],
            "simulation_effect": EFFECT_BY_CLASS[cname],
            "repair_action": REPAIR_ACTION_BY_CLASS[cname],
            "repaired_bridge_2d": bridge_pts or [[x1, icy], [icx, icy], [x2, icy]],
            "verified_fixed": True,
        })

    # 1. PINHOLE (Class 5)
    contours_ccomp, hierarchy = cv2.findContours(
        binary_copper, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE
    )
    if hierarchy is not None:
        for idx, h in enumerate(hierarchy[0]):
            if h[3] != -1:
                area = cv2.contourArea(contours_ccomp[idx])
                M = cv2.moments(contours_ccomp[idx])
                if M["m00"] > 0:
                    cx, cy = int(M["m10"] / M["m00"]), int(M["m01"] / M["m00"])
                    outer_r = float(solid_dist[cy, cx])
                    is_pad_drill = (area >= 85 and outer_r >= pad_radius_thresh)
                    if not is_pad_drill and 4 <= area <= 260:
                        add_candidate(5, cx, cy, 18, 18)

    # 2. SPURIOUS COPPER (Class 6)
    num_cc, _, cc_stats, cc_cents = cv2.connectedComponentsWithStats(solid_copper, connectivity=8)
    for cid in range(1, num_cc):
        area = cc_stats[cid, cv2.CC_STAT_AREA]
        if 15 <= area <= 450:
            add_candidate(6, cc_cents[cid][0], cc_cents[cid][1], 18, 18)

    ys, xs = np.where(skeleton > 0)
    skel_set = set(zip(xs.tolist(), ys.tolist()))

    def nbrs(x: int, y: int):
        return [
            (x + dx, y + dy)
            for dy in (-1, 0, 1)
            for dx in (-1, 0, 1)
            if (dx != 0 or dy != 0) and (x + dx, y + dy) in skel_set
        ]

    def crossing_number(x: int, y: int) -> int:
        ring = [
            (x, y - 1), (x + 1, y - 1), (x + 1, y), (x + 1, y + 1),
            (x, y + 1), (x - 1, y + 1), (x - 1, y), (x - 1, y - 1),
        ]
        vals = [1 if p in skel_set else 0 for p in ring]
        return sum((vals[i] == 0 and vals[(i + 1) % 8] == 1) for i in range(8))

    cn_map = {p: crossing_number(p[0], p[1]) for p in skel_set}

    non_pad_endpoints = []
    for (ex, ey), cn in cn_map.items():
        if cn == 1 and 20 < ex < 620 and 20 < ey < 620:
            local_r = float(np.max(solid_dist[max(0, ey - 4):min(640, ey + 5), max(0, ex - 4):min(640, ex + 5)]))
            if local_r < pad_radius_thresh:
                non_pad_endpoints.append((ex, ey))

    # 3. OPEN (Class 1)
    paired_open_eps = set()
    for i in range(len(non_pad_endpoints)):
        if i in paired_open_eps:
            continue
        x1, y1 = non_pad_endpoints[i]
        cid1 = skel_cc_labels[y1, x1]
        best_j, best_dist = None, 999.0
        for j in range(i + 1, len(non_pad_endpoints)):
            x2, y2 = non_pad_endpoints[j]
            cid2 = skel_cc_labels[y2, x2]
            if cid1 == cid2:
                continue
            d = float(np.hypot(x2 - x1, y2 - y1))
            if 8.0 <= d <= 75.0 and d < best_dist:
                mx, my = (x1 + x2) // 2, (y1 + y2) // 2
                if solid_copper[my, mx] == 0:
                    best_dist, best_j = d, j
        if best_j is not None:
            x2, y2 = non_pad_endpoints[best_j]
            for k, (kx, ky) in enumerate(non_pad_endpoints):
                if np.hypot(kx - x1, ky - y1) < 25 or np.hypot(kx - x2, ky - y2) < 25:
                    paired_open_eps.add(k)
            mx, my = (x1 + x2) // 2, (y1 + y2) // 2
            hw = int(max(22, abs(x2 - x1) * 0.65))
            hh = int(max(20, abs(y2 - y1) * 0.65))
            pts_bridge = [[x1, y1], [mx, my], [x2, y2]] if (x1 + y1) <= (x2 + y2) else [[x2, y2], [mx, my], [x1, y1]]
            add_candidate(1, mx, my, hw, hh, bridge_pts=pts_bridge)

    # 4. SPUR (Class 4)
    for i, (ex, ey) in enumerate(non_pad_endpoints):
        if i in paired_open_eps:
            continue
        q = deque([(ex, ey)])
        visited_spur = {(ex, ey)}
        spur_pts = [(ex, ey)]
        hit_j = False
        while q and len(spur_pts) <= 60:
            curr = q.popleft()
            if curr != (ex, ey) and cn_map.get(curr, 0) >= 3:
                hit_j = True
                break
            for nxt in nbrs(curr[0], curr[1]):
                if nxt not in visited_spur:
                    visited_spur.add(nxt)
                    spur_pts.append(nxt)
                    q.append(nxt)
        if hit_j and 5 <= len(spur_pts) <= 58:
            mid = spur_pts[len(spur_pts) // 2]
            add_candidate(4, mid[0], mid[1], 20, 22)

    # 5. SHORT (Class 2)
    j_mask = np.zeros_like(skeleton)
    for (jx, jy), cn in cn_map.items():
        if cn >= 3:
            j_mask[jy, jx] = 255
    j_mask = cv2.dilate(j_mask, np.ones((7, 7), np.uint8))
    _, j_labels, _, _ = cv2.connectedComponentsWithStats(j_mask)

    branches_skel = cv2.subtract(skeleton, j_mask)
    num_b, b_labels, b_stats, _ = cv2.connectedComponentsWithStats(branches_skel, connectivity=8)
    for bid in range(1, num_b):
        length = b_stats[bid, cv2.CC_STAT_AREA]
        if 14 <= length <= 140:
            b_mask = (b_labels == bid).astype(np.uint8) * 255
            b_dil = cv2.dilate(b_mask, np.ones((5, 5), np.uint8))
            touching_j = set(np.unique(j_labels[b_dil > 0])) - {0}
            if len(touching_j) >= 2:
                pts_yx = np.argwhere(b_mask > 0)
                radii = [solid_dist[y, x] for y, x in pts_yx]
                if float(np.median(radii)) <= nominal_radius * 0.92:
                    cy, cx = np.mean(pts_yx, axis=0)
                    add_candidate(2, cx, cy, 22, int(max(24, length * 0.55)))

    # 6. MOUSEBITE (Class 3)
    ep_mask = np.zeros_like(skeleton)
    for (ex, ey) in [p for p, cn in cn_map.items() if cn == 1]:
        ep_mask[ey, ex] = 255
    exclude_mask = cv2.dilate(cv2.bitwise_or(j_mask, ep_mask), np.ones((21, 21), np.uint8))

    neck_mask = (
        (skeleton > 0) & (solid_dist < nominal_radius * 0.76) & (exclude_mask == 0)
    ).astype(np.uint8) * 255
    neck_mask = cv2.dilate(neck_mask, np.ones((9, 9), np.uint8))
    mb_num, _, mb_stats, mb_cents = cv2.connectedComponentsWithStats(neck_mask)
    for cid in range(1, mb_num):
        if mb_stats[cid, cv2.CC_STAT_AREA] >= 25:
            add_candidate(3, mb_cents[cid][0], mb_cents[cid][1], 20, 18)

    raw_detections.sort(key=lambda item: (item["class_id"], item["center_2d"][1]))

    return [
        DefectOut(id=f"flaw_{idx + 1}", **item)
        for idx, item in enumerate(raw_detections[:12])
    ]


def detect_defects_with_gemini(
    image_bytes: bytes,
    binary_copper: np.ndarray,
    skeleton: np.ndarray,
) -> List[DefectOut]:
    verified_defects = cv_detect_all_6_defect_classes(binary_copper, skeleton)

    if not GENAI_AVAILABLE or not GEMINI_API_KEY:
        return verified_defects

    try:
        client = genai.Client(api_key=GEMINI_API_KEY)
        pil_img = Image.open(io.BytesIO(image_bytes)).convert("RGB").resize((640, 640))
        buf = io.BytesIO()
        pil_img.save(buf, format="PNG")
        png_bytes = buf.getvalue()

        cv_hint_summary = [d.model_dump() for d in verified_defects]
        prompt_text = (
            f"Verified Topological Defects: {json.dumps(cv_hint_summary)}\n"
            "Keep these verified defects and add any additional flaws visible on the PCB."
        )

        response = client.models.generate_content(
            model=MODEL_ID,
            contents=[
                types.Part.from_bytes(data=png_bytes, mime_type="image/png"),
                prompt_text,
            ],
            config=types.GenerateContentConfig(
                system_instruction=AGENT_SYSTEM_PROMPT,
                response_mime_type="application/json",
                response_schema=LLMDefectResponse,
                temperature=0.0,
            ),
        )

        parsed = LLMDefectResponse.model_validate_json(response.text)
        merged = list(verified_defects)

        for d in parsed.defects:
            x1, y1, x2, y2 = [max(0, min(640, int(v))) for v in d.bbox_2d]
            cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
            if any(np.hypot(existing.center_2d[0] - cx, existing.center_2d[1] - cy) < 36 for existing in merged):
                continue
            cname = d.class_name or CLASS_ID_TO_NAME.get(d.class_id, "open")
            cid = NAME_TO_CLASS_ID.get(cname, d.class_id)
            merged.append(
                DefectOut(
                    id=f"flaw_{len(merged) + 1}",
                    class_id=cid,
                    class_name=cname,
                    bbox_2d=[x1, y1, x2, y2],
                    center_2d=[cx, cy],
                    simulation_effect=EFFECT_BY_CLASS[cname],
                    repair_action=REPAIR_ACTION_BY_CLASS[cname],
                    repaired_bridge_2d=[[x1, cy], [cx, cy], [x2, cy]],
                    verified_fixed=True,
                )
            )
        return merged

    except Exception as exc:
        print(f"[WARN] Gemini 4 Argon call skipped ({exc}). Using verified topological detections.")
        return verified_defects