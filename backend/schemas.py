import os
from typing import List, Optional, Literal
from pydantic import BaseModel, Field

MODEL_ID = os.getenv("GEMINI_MODEL_ID", "gemini-4-argon")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
MAX_VERIFY_ITERATIONS = 3

CLASS_ID_TO_NAME = {
    1: "open",
    2: "short",
    3: "mousebite",
    4: "spur",
    5: "pinhole",
    6: "spurious_copper",
}

NAME_TO_CLASS_ID = {v: k for k, v in CLASS_ID_TO_NAME.items()}

EFFECT_BY_CLASS = {
    "open": "STOP_CURRENT",
    "short": "ARC_SHORT",
    "mousebite": "BOTTLENECK_HEAT",
    "spur": "PARASITIC_BOUNCE",
    "pinhole": "BOTTLENECK_HEAT",
    "spurious_copper": "PARASITIC_BOUNCE",
}

REPAIR_ACTION_BY_CLASS = {
    "open": "SOLDER_JUMPER_BRIDGE",
    "short": "LASER_SEVER_BRIDGE",
    "mousebite": "SOLDER_FILLET_REINFORCE",
    "spur": "ETCH_REMOVE_SPUR",
    "pinhole": "COPPER_FILL_VOID",
    "spurious_copper": "MILL_ISOLATED_COPPER",
}

AGENT_SYSTEM_PROMPT = """
You are the PCB Defect & Self-Correcting Circuit Topology Agent.
You receive:
1. A 640x640 2D binary PCB image (DeepPCB format).
2. Verified topological defect detections from Distance-Transform & Skeleton-Graph analysis.

Your task:
1. Inspect the 2D PCB image and detect all manufacturing flaws across the 6 DeepPCB classes:
   - 1: "open" (a break/gap interrupting a copper trace)
   - 2: "short" (unintended copper bridge connecting two separate traces)
   - 3: "mousebite" (sharp bite/indentation along the edge of a trace)
   - 4: "spur" (sharp unwanted copper spike sticking out of a trace)
   - 5: "pinhole" (tiny void/hole inside a copper trace or pad)
   - 6: "spurious_copper" (isolated copper island sitting on the substrate)
2. Keep all verified topological candidates and add any additional defects visible in the image.
Return ONLY valid JSON matching the requested schema.
"""


class LLMDetectedDefect(BaseModel):
    class_id: int = Field(..., description="1=open, 2=short, 3=mousebite, 4=spur, 5=pinhole, 6=spurious_copper")
    class_name: Literal["open", "short", "mousebite", "spur", "pinhole", "spurious_copper"]
    bbox_2d: List[int] = Field(..., description="[x1, y1, x2, y2] in 0..640 pixel space")


class LLMDefectResponse(BaseModel):
    defects: List[LLMDetectedDefect]


class DefectOut(BaseModel):
    id: str
    class_id: int
    class_name: str
    bbox_2d: List[int]
    center_2d: List[int]
    simulation_effect: str
    repair_action: str = "SOLDER_JUMPER_BRIDGE"
    repaired_bridge_2d: List[List[int]] = Field(default_factory=list)
    verified_fixed: bool = True


class TraceOut(BaseModel):
    trace_id: str
    status: Literal["nominal", "broken", "shorted", "constricted", "parasitic", "repaired"]
    blocking_defect_id: Optional[str] = None
    active_waypoints_2d: List[List[int]]
    dead_waypoints_2d: List[List[int]] = Field(default_factory=list)


class VerificationReport(BaseModel):
    verified: bool
    iterations_run: int
    initial_defect_count: int
    residual_defect_count: int
    log: List[str] = Field(default_factory=list)


class SimulationManifest(BaseModel):
    image_size: List[int] = [640, 640]
    copper_is_dark: bool = True
    defects: List[DefectOut]
    traces: List[TraceOut]
    fixed_traces: List[TraceOut] = Field(default_factory=list)
    verification: Optional[VerificationReport] = None