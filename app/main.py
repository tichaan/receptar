import json
import shutil
import uuid
from pathlib import Path

import fitz
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Any

from pdf_utils import (
    build_zip,
    detect_staff_lines,
    export_parts,
    get_page_dimensions,
    render_page,
)

BASE_DIR = Path(__file__).parent.parent
SESSIONS_DIR = BASE_DIR / "sessions"
STATIC_DIR = BASE_DIR / "static"
SESSIONS_DIR.mkdir(exist_ok=True)

app = FastAPI(title="Score Splitter")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def session_path(sid: str) -> Path:
    return SESSIONS_DIR / sid


def load_session(sid: str) -> dict:
    p = session_path(sid) / "session.json"
    if not p.exists():
        raise HTTPException(404, "Session not found")
    with open(p) as f:
        return json.load(f)


def save_session(sid: str, data: dict):
    with open(session_path(sid) / "session.json", "w") as f:
        json.dump(data, f, indent=2)


# ─── Upload ──────────────────────────────────────────────────────────────────

@app.post("/api/upload")
async def upload_pdf(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Only PDF files accepted")

    sid = uuid.uuid4().hex
    sdir = session_path(sid)
    sdir.mkdir(parents=True)

    pdf_path = sdir / "source.pdf"
    content = await file.read()
    pdf_path.write_bytes(content)

    doc = fitz.open(str(pdf_path))
    n_pages = len(doc)
    doc.close()

    session_data = {
        "id": sid,
        "filename": file.filename,
        "page_count": n_pages,
        "pages": [{"rotation": 0.0, "cuts": []} for _ in range(n_pages)],
        "parts": ["Soprano", "Alto", "Tenor", "Bass"],
        "strips": [],   # list of {id, page, y_start, y_end, part}
        "layout": {},   # part_name -> ordered list of strip ids
    }
    save_session(sid, session_data)

    return {"session_id": sid, "page_count": n_pages, "filename": file.filename}


# ─── Session state ────────────────────────────────────────────────────────────

@app.get("/api/session/{sid}")
def get_session(sid: str):
    return load_session(sid)


class SessionUpdate(BaseModel):
    data: dict[str, Any]


@app.put("/api/session/{sid}")
def put_session(sid: str, body: SessionUpdate):
    # Merge top-level keys from body.data into stored session
    session = load_session(sid)
    session.update(body.data)
    save_session(sid, session)
    return {"ok": True}


# ─── Page rendering ───────────────────────────────────────────────────────────

@app.get("/api/render/{sid}/{page_index}")
def render(sid: str, page_index: int, dpi: int = 150):
    session = load_session(sid)
    if page_index < 0 or page_index >= session["page_count"]:
        raise HTTPException(400, "Page index out of range")
    pdf_path = str(session_path(sid) / "source.pdf")
    rotation = session["pages"][page_index].get("rotation", 0.0)
    img_bytes = render_page(pdf_path, page_index, dpi=dpi, rotation=rotation)
    return Response(content=img_bytes, media_type="image/png")


@app.get("/api/dimensions/{sid}/{page_index}")
def dimensions(sid: str, page_index: int):
    session = load_session(sid)
    pdf_path = str(session_path(sid) / "source.pdf")
    rotation = session["pages"][page_index].get("rotation", 0.0)
    return get_page_dimensions(pdf_path, page_index, rotation=rotation)


# ─── Staff-line detection ─────────────────────────────────────────────────────

@app.get("/api/detect/{sid}/{page_index}")
def detect(sid: str, page_index: int):
    session = load_session(sid)
    pdf_path = str(session_path(sid) / "source.pdf")
    rotation = session["pages"][page_index].get("rotation", 0.0)
    cuts = detect_staff_lines(pdf_path, page_index, rotation=rotation)
    return {"cuts": cuts}


# ─── Export ───────────────────────────────────────────────────────────────────

@app.post("/api/export/{sid}")
def export(sid: str):
    session = load_session(sid)
    pdf_path = str(session_path(sid) / "source.pdf")
    out_dir = session_path(sid) / "export"

    # Rebuild layout from strips
    layout: dict[str, list] = {}
    for strip in session.get("strips", []):
        part = strip.get("part", "")
        if not part:
            continue
        if part not in layout:
            layout[part] = []
        layout[part].append({
            "page": strip["page"],
            "y_start": strip["y_start"],
            "y_end": strip["y_end"],
        })

    # Respect custom ordering from session["layout"]
    ordered_layout: dict[str, list] = {}
    for part_name, strip_ids in session.get("layout", {}).items():
        strip_map = {s["id"]: s for s in session["strips"]}
        ordered_strips = []
        for sid_strip in strip_ids:
            s = strip_map.get(sid_strip)
            if s and s.get("part") == part_name:
                ordered_strips.append({
                    "page": s["page"],
                    "y_start": s["y_start"],
                    "y_end": s["y_end"],
                })
        ordered_layout[part_name] = ordered_strips

    export_session = dict(session)
    export_session["layout"] = ordered_layout if ordered_layout else layout

    paths = export_parts(pdf_path, export_session, out_dir)
    if not paths:
        raise HTTPException(400, "No parts to export — assign strips to parts first")

    zip_bytes = build_zip(paths)
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=score_parts.zip"},
    )


@app.get("/api/export/{sid}/{part_name}")
def export_single(sid: str, part_name: str):
    session = load_session(sid)
    pdf_path = str(session_path(sid) / "source.pdf")
    out_dir = session_path(sid) / "export"

    strip_map = {s["id"]: s for s in session["strips"]}
    ordered_layout: dict[str, list] = {}
    for pname, strip_ids in session.get("layout", {}).items():
        if pname != part_name:
            continue
        strips_out = []
        for sid_strip in strip_ids:
            s = strip_map.get(sid_strip)
            if s:
                strips_out.append({
                    "page": s["page"],
                    "y_start": s["y_start"],
                    "y_end": s["y_end"],
                })
        ordered_layout[pname] = strips_out

    export_session = dict(session)
    export_session["layout"] = ordered_layout

    paths = export_parts(pdf_path, export_session, out_dir)
    if not paths:
        raise HTTPException(400, "No strips found for this part")

    path = paths[0]
    return FileResponse(
        str(path),
        media_type="application/pdf",
        filename=path.name,
    )


# ─── Static files (must be last) ─────────────────────────────────────────────

app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
