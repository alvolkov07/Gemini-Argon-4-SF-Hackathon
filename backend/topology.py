from typing import List, Optional, Literal
import cv2
import numpy as np

from .schemas import DefectOut, TraceOut, VerificationReport, SimulationManifest
from .detector import build_solid_and_skeleton


def extract_8connected_chains(comp_mask: np.ndarray, step: int = 7) -> List[List[List[int]]]:
    ys, xs = np.where(comp_mask > 0)
    if len(xs) < 12:
        return []

    pixel_set = set(zip(xs.tolist(), ys.tolist()))

    def get_neighbors(x: int, y: int):
        return [
            (x + dx, y + dy)
            for dy in (-1, 0, 1)
            for dx in (-1, 0, 1)
            if (dx != 0 or dy != 0) and (x + dx, y + dy) in pixel_set
        ]

    endpoints = [p for p in pixel_set if len(get_neighbors(p[0], p[1])) == 1]
    endpoints.sort(key=lambda p: p[0] + p[1])
    start_nodes = endpoints if endpoints else [min(pixel_set, key=lambda p: p[0] + p[1])]

    visited = set()
    chains: List[List[List[int]]] = []

    for start in start_nodes:
        if start in visited:
            continue
        stack = [(start, [start])]
        visited.add(start)

        while stack:
            curr, path = stack.pop()
            unvisited_nbrs = [n for n in get_neighbors(curr[0], curr[1]) if n not in visited]

            if len(unvisited_nbrs) == 1:
                nxt = unvisited_nbrs[0]
                visited.add(nxt)
                path.append(nxt)
                stack.append((nxt, path))
            elif len(unvisited_nbrs) > 1:
                nxt_main = unvisited_nbrs[0]
                visited.add(nxt_main)
                for branch_nbr in unvisited_nbrs[1:]:
                    visited.add(branch_nbr)
                    stack.append((branch_nbr, [curr, branch_nbr]))
                path.append(nxt_main)
                stack.append((nxt_main, path))
            else:
                if len(path) >= 14:
                    sub = [[p[0], p[1]] for p in path[::step]]
                    last_pt = [path[-1][0], path[-1][1]]
                    if sub[-1] != last_pt:
                        sub.append(last_pt)
                    if len(sub) >= 3:
                        if (sub[0][0] + sub[0][1]) > (sub[-1][0] + sub[-1][1]):
                            sub = list(reversed(sub))
                        chains.append(sub)

    return chains


def extract_clean_pcb_traces(
    binary_copper: np.ndarray, skeleton: np.ndarray, defects: List[DefectOut], max_traces: int = 34
) -> List[dict]:
    copper_clean = binary_copper.copy()
    solid, _ = build_solid_and_skeleton(binary_copper)
    dist_map = cv2.distanceTransform(solid, cv2.DIST_L2, 5)
    skel_dists = dist_map[skeleton > 0]
    trace_radii = skel_dists[(skel_dists >= 3.0) & (skel_dists <= 13.5)]
    nom_r = float(np.median(trace_radii)) if len(trace_radii) > 0 else 8.0

    open_k = int(max(9, round(nom_r * 1.6)))
    if open_k % 2 == 0:
        open_k += 1
    shaved = cv2.morphologyEx(
        copper_clean,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (open_k, open_k)),
    )

    for d in defects:
        x1, y1, x2, y2 = d.bbox_2d
        cx, cy = d.center_2d
        if d.class_name == "pinhole":
            cv2.circle(copper_clean, (cx, cy), 12, 255, -1)
        elif d.class_name == "spurious_copper":
            cv2.rectangle(copper_clean, (x1, y1), (x2, y2), 0, -1)
        elif d.class_name in ("short", "spur"):
            copper_clean[y1:y2, x1:x2] = shaved[y1:y2, x1:x2]

    _, skel_clean = build_solid_and_skeleton(copper_clean)
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(skel_clean, connectivity=8)

    component_ids = sorted(
        range(1, num_labels),
        key=lambda cid: stats[cid, cv2.CC_STAT_AREA],
        reverse=True,
    )

    traces = []
    for cid in component_ids:
        if len(traces) >= max_traces:
            break
        if stats[cid, cv2.CC_STAT_AREA] < 16:
            continue
        comp_mask = (labels == cid).astype(np.uint8)
        for chain in extract_8connected_chains(comp_mask, step=7):
            if len(traces) >= max_traces:
                break
            traces.append({
                "trace_id": f"net_{len(traces) + 1:02d}",
                "waypoints_2d": chain,
            })

    return traces


def point_in_box(pt: List[int], bbox: List[int], margin: int = 16) -> bool:
    px, py = pt[0], pt[1]
    x1, y1, x2, y2 = bbox
    return (x1 - margin) <= px <= (x2 + margin) and (y1 - margin) <= py <= (y2 + margin)


def self_correct_traces(defective_traces: List[TraceOut], defects: List[DefectOut]) -> List[TraceOut]:
    defect_map = {d.id: d for d in defects}
    healed_traces: List[TraceOut] = []

    for t in defective_traces:
        if t.trace_id.startswith("short_bridge_") or t.trace_id.startswith("parasitic_"):
            continue

        if t.status == "broken":
            d = defect_map.get(t.blocking_defect_id) if t.blocking_defect_id else None
            bridge_mid = [d.center_2d] if d else []
            merged_pts = list(t.active_waypoints_2d) + bridge_mid + list(t.dead_waypoints_2d)

            if d and t.active_waypoints_2d and t.dead_waypoints_2d:
                d.repaired_bridge_2d = [
                    t.active_waypoints_2d[-1],
                    d.center_2d,
                    t.dead_waypoints_2d[0],
                ]

            healed_traces.append(
                TraceOut(
                    trace_id=t.trace_id,
                    status="repaired",
                    blocking_defect_id=t.blocking_defect_id,
                    active_waypoints_2d=merged_pts,
                    dead_waypoints_2d=[],
                )
            )
        elif t.status in ("constricted", "shorted", "parasitic"):
            healed_traces.append(
                TraceOut(
                    trace_id=t.trace_id,
                    status="repaired",
                    blocking_defect_id=t.blocking_defect_id,
                    active_waypoints_2d=t.active_waypoints_2d,
                    dead_waypoints_2d=[],
                )
            )
        else:
            healed_traces.append(
                TraceOut(
                    trace_id=t.trace_id,
                    status="nominal",
                    blocking_defect_id=None,
                    active_waypoints_2d=t.active_waypoints_2d,
                    dead_waypoints_2d=[],
                )
            )

    return healed_traces


def intersect_traces_with_defects(
    traces: List[dict],
    defects: List[DefectOut],
    copper_is_dark: bool,
    verification: VerificationReport,
) -> SimulationManifest:
    consumed_trace_ids = set()
    final_traces: List[TraceOut] = []

    open_defects = [d for d in defects if d.class_name == "open"]
    for od in open_defects:
        touching = []
        for t in traces:
            if t["trace_id"] in consumed_trace_ids:
                continue
            pts = t["waypoints_2d"]
            if point_in_box(pts[-1], od.bbox_2d, margin=24):
                touching.append((pts[0][0] + pts[0][1], t, list(pts), "end_at_break"))
            elif point_in_box(pts[0], od.bbox_2d, margin=24):
                touching.append((pts[-1][0] + pts[-1][1], t, list(pts), "start_at_break"))

        if len(touching) >= 2:
            touching.sort(key=lambda item: item[0])
            _, t_up, pts_up, mode_up = touching[0]
            _, t_down, pts_down, mode_down = touching[1]

            if mode_up == "start_at_break":
                pts_up = list(reversed(pts_up))
            if mode_down == "end_at_break":
                pts_down = list(reversed(pts_down))

            consumed_trace_ids.add(t_up["trace_id"])
            consumed_trace_ids.add(t_down["trace_id"])
            od.repaired_bridge_2d = [pts_up[-1], od.center_2d, pts_down[0]]

            final_traces.append(
                TraceOut(
                    trace_id=t_up["trace_id"],
                    status="broken",
                    blocking_defect_id=od.id,
                    active_waypoints_2d=pts_up,
                    dead_waypoints_2d=pts_down,
                )
            )

    for t in traces:
        if t["trace_id"] in consumed_trace_ids:
            continue

        pts = t["waypoints_2d"]
        status: Literal["nominal", "broken", "shorted", "constricted", "parasitic"] = "nominal"
        blocking_id: Optional[str] = None

        for d in defects:
            for pt in pts:
                if point_in_box(pt, d.bbox_2d, margin=16):
                    blocking_id = d.id
                    if d.class_name == "short":
                        status = "shorted"
                        break
                    elif d.class_name in ("mousebite", "pinhole"):
                        status = "constricted"
                        break
                    elif d.class_name in ("spur", "spurious_copper"):
                        status = "parasitic"
                        break

        final_traces.append(
            TraceOut(
                trace_id=t["trace_id"],
                status=status,
                blocking_defect_id=blocking_id,
                active_waypoints_2d=pts,
                dead_waypoints_2d=[],
            )
        )

    for d in defects:
        x1, y1, x2, y2 = d.bbox_2d
        cx, cy = d.center_2d
        if d.class_name == "short":
            final_traces.append(
                TraceOut(
                    trace_id=f"short_bridge_{d.id}",
                    status="shorted",
                    blocking_defect_id=d.id,
                    active_waypoints_2d=[[cx, y1 + 4], [cx, cy], [cx, y2 - 4]],
                    dead_waypoints_2d=[],
                )
            )
        elif d.class_name in ("spur", "spurious_copper"):
            final_traces.append(
                TraceOut(
                    trace_id=f"parasitic_{d.id}",
                    status="parasitic",
                    blocking_defect_id=d.id,
                    active_waypoints_2d=[[cx - 8, cy], [cx, cy - 8], [cx + 8, cy], [cx, cy + 8]],
                    dead_waypoints_2d=[],
                )
            )

    fixed_traces = self_correct_traces(final_traces, defects)

    return SimulationManifest(
        image_size=[640, 640],
        copper_is_dark=copper_is_dark,
        defects=defects,
        traces=final_traces,
        fixed_traces=fixed_traces,
        verification=verification,
    )