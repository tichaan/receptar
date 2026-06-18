import fitz  # PyMuPDF
import io
import math
import numpy as np
from PIL import Image, ImageDraw
from pathlib import Path
import zipfile


DPI = 150  # rendering DPI for editing canvas
EXPORT_DPI = 200  # higher DPI for exported PDFs


def render_page(pdf_path: str, page_index: int, dpi: int = DPI, rotation: float = 0.0) -> bytes:
    """Render a single PDF page to PNG bytes, applying rotation."""
    doc = fitz.open(pdf_path)
    page = doc[page_index]
    zoom = dpi / 72.0
    mat = fitz.Matrix(zoom, zoom).prerotate(rotation)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    doc.close()

    img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=False)
    return buf.getvalue()


def get_page_dimensions(pdf_path: str, page_index: int, dpi: int = DPI, rotation: float = 0.0) -> dict:
    doc = fitz.open(pdf_path)
    page = doc[page_index]
    zoom = dpi / 72.0
    mat = fitz.Matrix(zoom, zoom).prerotate(rotation)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    doc.close()
    return {"width": pix.width, "height": pix.height}


def detect_staff_lines(pdf_path: str, page_index: int, rotation: float = 0.0) -> list[float]:
    """
    Detect horizontal staff lines via horizontal projection.
    Returns y-positions (0..1, relative to image height) between systems.
    """
    img_bytes = render_page(pdf_path, page_index, dpi=DPI, rotation=rotation)
    img = Image.open(io.BytesIO(img_bytes)).convert("L")
    arr = np.array(img, dtype=np.float32)
    h, w = arr.shape

    # Horizontal projection: mean darkness per row (lower = darker = more ink)
    proj = arr.mean(axis=1)
    # Invert: staff lines are dark → high values now mean dark rows
    proj_inv = 255.0 - proj

    # Smooth with a rolling window
    window = max(1, h // 100)
    kernel = np.ones(window) / window
    smoothed = np.convolve(proj_inv, kernel, mode="same")

    # Find regions of low ink (gaps between systems)
    threshold = smoothed.mean() * 0.4
    in_gap = False
    gap_starts = []
    gap_ends = []
    for i, v in enumerate(smoothed):
        if not in_gap and v < threshold:
            in_gap = True
            gap_starts.append(i)
        elif in_gap and v >= threshold:
            in_gap = False
            gap_ends.append(i)
    if in_gap:
        gap_ends.append(h - 1)

    # Skip very top and bottom margins
    margin = int(h * 0.05)
    cuts = []
    for s, e in zip(gap_starts, gap_ends):
        mid = (s + e) / 2
        if mid > margin and mid < h - margin:
            cuts.append(round(mid / h, 4))

    return cuts


def _rotate_pil(img: Image.Image, angle: float) -> Image.Image:
    if abs(angle) < 0.01:
        return img
    return img.rotate(-angle, expand=True, resample=Image.BICUBIC, fillcolor=(255, 255, 255))


def export_parts(pdf_path: str, session: dict, output_dir: Path) -> list[Path]:
    """
    Build one PDF per part based on session layout.

    session["layout"] = {
      "part_name": [
        {"page": 0, "y_start": 0.0, "y_end": 0.5},  # fractions of rendered image height
        ...
      ]
    }
    session["pages"] = [{"rotation": 0.0}, ...]
    """
    doc = fitz.open(pdf_path)
    output_dir.mkdir(parents=True, exist_ok=True)
    out_paths = []

    for part_name, strips in session.get("layout", {}).items():
        if not strips:
            continue

        out_doc = fitz.open()

        for strip in strips:
            page_idx = strip["page"]
            y_start_frac = strip["y_start"]
            y_end_frac = strip["y_end"]
            rotation = session["pages"][page_idx].get("rotation", 0.0)

            # Render at export DPI
            img_bytes = render_page(pdf_path, page_idx, dpi=EXPORT_DPI, rotation=rotation)
            img = Image.open(io.BytesIO(img_bytes))
            w, h = img.size

            y0 = int(y_start_frac * h)
            y1 = int(y_end_frac * h)
            y0 = max(0, min(y0, h - 1))
            y1 = max(y0 + 1, min(y1, h))

            strip_img = img.crop((0, y0, w, y1))

            # Convert strip image to PDF page
            strip_buf = io.BytesIO()
            strip_img.save(strip_buf, format="PNG")
            strip_buf.seek(0)

            # Page size in points (72 pt/inch)
            pt_w = strip_img.width * 72 / EXPORT_DPI
            pt_h = strip_img.height * 72 / EXPORT_DPI

            new_page = out_doc.new_page(width=pt_w, height=pt_h)
            rect = fitz.Rect(0, 0, pt_w, pt_h)
            new_page.insert_image(rect, stream=strip_buf.read())

        safe_name = "".join(c if c.isalnum() or c in " _-" else "_" for c in part_name)
        out_path = output_dir / f"{safe_name}.pdf"
        out_doc.save(str(out_path))
        out_doc.close()
        out_paths.append(out_path)

    doc.close()
    return out_paths


def build_zip(pdf_paths: list[Path]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for p in pdf_paths:
            zf.write(p, p.name)
    return buf.getvalue()
