from typing import List, Tuple
import cv2
import numpy as np

from .schemas import MAX_VERIFY_ITERATIONS, DefectOut, VerificationReport
from .detector import build_solid_and_skeleton, cv_detect_all_6_defect_classes


def apply_smart_copper_surgery(
    binary_copper: np.ndarray, defects: List[DefectOut], gain: float = 1.0
) -> np.ndarray:
    repaired = binary_copper.copy()
    solid, _ = build_solid_and_skeleton(repaired)
    dist_map = cv2.distanceTransform(solid, cv2.DIST_L2, 5)
    copper_radii = dist_map[solid > 0]
    valid_r = copper_radii[(copper_radii >= 3.0) & (copper_radii <= 13.5)]
    nom_r = float(np.median(valid_r)) if len(valid_r) > 0 else 8.0
    trace_thickness = int(round(nom_r * 2.05 * gain))

    open_k = int(max(9, round(nom_r * 1.65 * gain)))
    if open_k % 2 == 0:
        open_k += 1
    shaved = cv2.morphologyEx(
        repaired,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (open_k, open_k)),
    )

    close_k = int(max(21, round(nom_r * 3.0 * gain)))
    if close_k % 2 == 0:
        close_k += 1
    closed_board = cv2.morphologyEx(
        repaired,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (close_k, close_k)),
    )

    for d in defects:
        x1, y1, x2, y2 = d.bbox_2d
        cx, cy = d.center_2d
        cname = d.class_name
        pad = int(6 * gain)
        bx1, by1 = max(0, x1 - pad), max(0, y1 - pad)
        bx2, by2 = min(640, x2 + pad), min(640, y2 + pad)

        if cname == "open":
            pts = d.repaired_bridge_2d if len(d.repaired_bridge_2d) >= 2 else [[bx1, cy], [cx, cy], [bx2, cy]]
            for i in range(len(pts) - 1):
                cv2.line(repaired, tuple(pts[i]), tuple(pts[i + 1]), 255, trace_thickness)
            sub_close = cv2.morphologyEx(
                repaired[by1:by2, bx1:bx2], cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8)
            )
            repaired[by1:by2, bx1:bx2] = sub_close
        elif cname == "mousebite":
            repaired[by1:by2, bx1:bx2] = closed_board[by1:by2, bx1:bx2]
        elif cname == "pinhole":
            cv2.circle(repaired, (cx, cy), int(round(nom_r * 1.15 * gain)), 255, -1)
        elif cname in ("short", "spur"):
            repaired[by1:by2, bx1:bx2] = shaved[by1:by2, bx1:bx2]
        elif cname == "spurious_copper":
            cv2.rectangle(repaired, (bx1, by1), (bx2, by2), 0, -1)

    return repaired


def verify_and_self_correct_loop(
    binary_copper: np.ndarray, initial_defects: List[DefectOut]
) -> Tuple[np.ndarray, VerificationReport]:
    log: List[str] = [
        f"Iter 0 (Detect): Found {len(initial_defects)} initial flaws "
        f"({', '.join(d.class_name for d in initial_defects) or 'none'})."
    ]

    if not initial_defects:
        return binary_copper.copy(), VerificationReport(
            verified=True,
            iterations_run=0,
            initial_defect_count=0,
            residual_defect_count=0,
            log=log,
        )

    working_copper = binary_copper.copy()
    active_repairs = list(initial_defects)
    residual_defects: List[DefectOut] = []

    for iteration in range(1, MAX_VERIFY_ITERATIONS + 1):
        gain = 1.0 + 0.25 * (iteration - 1)
        working_copper = apply_smart_copper_surgery(working_copper, active_repairs, gain=gain)
        _, repaired_skeleton = build_solid_and_skeleton(working_copper)
        residual_defects = cv_detect_all_6_defect_classes(working_copper, repaired_skeleton)

        if len(residual_defects) == 0:
            log.append(
                f"Iter {iteration} (Verify @ gain={gain:.2f}): Re-ran 6-class detector on repaired PCB -> "
                "0 residual flaws. Verification PASSED."
            )
            return working_copper, VerificationReport(
                verified=True,
                iterations_run=iteration,
                initial_defect_count=len(initial_defects),
                residual_defect_count=0,
                log=log,
            )

        log.append(
            f"Iter {iteration} (Verify @ gain={gain:.2f}): {len(residual_defects)} residual flaw(s) detected "
            f"({', '.join(d.class_name for d in residual_defects)}). Adapting surgery gain..."
        )
        active_repairs.extend(residual_defects)

    return working_copper, VerificationReport(
        verified=(len(residual_defects) == 0),
        iterations_run=MAX_VERIFY_ITERATIONS,
        initial_defect_count=len(initial_defects),
        residual_defect_count=len(residual_defects),
        log=log,
    )