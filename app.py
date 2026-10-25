import hashlib
import asyncio
from pathlib import Path

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from backend.schemas import MODEL_ID, MAX_VERIFY_ITERATIONS, SimulationManifest
from backend.detector import preprocess_pcb_image, detect_defects_with_gemini
from backend.verifier import verify_and_self_correct_loop
from backend.topology import extract_clean_pcb_traces, intersect_traces_with_defects

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="DeepPCB Closed-Loop Self-Correcting Simulator", version="5.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=500)

# Mount the /static folder so modular CSS and ES Module JS files resolve automatically
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

MANIFEST_CACHE: dict[str, SimulationManifest] = {}


@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "model": MODEL_ID,
        "verification_loop_enabled": True,
        "max_verify_iterations": MAX_VERIFY_ITERATIONS,
    }


@app.post("/analyze", response_model=SimulationManifest)
async def analyze_pcb(file: UploadFile = File(...)):
    if file.content_type and not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Uploaded file must be an image.")

    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    img_hash = hashlib.sha256(image_bytes).hexdigest()
    if img_hash in MANIFEST_CACHE:
        return MANIFEST_CACHE[img_hash]

    def _run_pipeline():
        _, binary_copper, skeleton, copper_is_dark = preprocess_pcb_image(image_bytes)
        defects = detect_defects_with_gemini(image_bytes, binary_copper, skeleton)
        traces = extract_clean_pcb_traces(binary_copper, skeleton, defects)
        _, verification_report = verify_and_self_correct_loop(binary_copper, defects)
        return intersect_traces_with_defects(traces, defects, copper_is_dark, verification_report)

    try:
        manifest = await asyncio.to_thread(_run_pipeline)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err))

    MANIFEST_CACHE[img_hash] = manifest
    return manifest


@app.get("/")
async def serve_index():
    index_path = STATIC_DIR / "index.html"
    if index_path.exists():
        return FileResponse(index_path, headers={"Cache-Control": "no-store"})
    return HTMLResponse("<h3>DeepPCB Server running on :8000 (Place index.html inside static/)</h3>")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
    # Server running on http://localhost:8000 