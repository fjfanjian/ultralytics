"""YOLOE 本地图片工作台：标准库服务，官方推理器，不修改 Ultralytics 核心。"""

import argparse
import gc
import hashlib
import io
import json
import logging
import mimetypes
import os
import secrets
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE.parents[1]))
os.environ["YOLO_CONFIG_DIR"] = str(BASE / "runtime/config")
os.environ["YOLO_AUTOINSTALL"] = "false"  # 依赖由启动脚本准备，不在运行中的进程替换 torch。
import numpy as np
import torch
from PIL import Image, ImageDraw, ImageOps

from ultralytics import YOLOE, __version__
from ultralytics.data.augment import LetterBox, LoadVisualPrompt
from ultralytics.models.yolo.yoloe import YOLOEVPSegPredictor

RUNTIME = BASE / "runtime"
RUNTIME.mkdir(exist_ok=True)
os.chdir(RUNTIME)
LOGGER = logging.getLogger(__name__)
TOKEN = secrets.token_urlsafe(24)
FILES = {}
JOBS = {}
LOCK = threading.Lock()
EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}
MODELS = [
    f"yoloe-{family}{size}-seg.pt"
    for family, sizes in [("26", "nsmlx"), ("11", "sml"), ("v8", "sml")]
    for size in sizes
]


def read_image(path):
    with Image.open(path) as image:
        return ImageOps.exif_transpose(image).convert("RGB")


def file_path(key):
    if key not in FILES:
        raise ValueError("图片未登记，请重新打开目录")
    return FILES[key]


def visual_embedding(model, config, device):
    image = read_image(file_path(config["reference"]))
    w, h = image.size
    shapes = config.get("shapes", [])
    if not shapes or len(shapes) > 256:
        raise ValueError("请标注 1 至 256 个视觉示例")
    class_ids = sorted({int(s["cls"]) for s in shapes})
    if class_ids != list(range(len(class_ids))):
        raise ValueError("已标注的类别必须从 0 连续编号，请为每一类提供示例")
    classes = np.array([int(s["cls"]) for s in shapes])
    names = config.get("names", [])
    if len(names) != len(class_ids) or any(not str(n).strip() for n in names):
        raise ValueError("每个类别都需要名称和至少一个示例")
    points = [np.array(s["points"], dtype=float) for s in shapes]
    for pts in points:
        if pts.ndim != 2 or pts.shape[1] != 2 or not np.isfinite(pts).all():
            raise ValueError("无效标注坐标")
        if (pts < 0).any() or (pts[:, 0] > w).any() or (pts[:, 1] > h).any():
            raise ValueError("标注超出参考图片范围")
    predictor = YOLOEVPSegPredictor(overrides={"device": device, "imgsz": config["imgsz"], "verbose": False})
    predictor.setup_model(model=model.model, verbose=False)
    if all(s["kind"] == "box" for s in shapes):
        boxes = [np.concatenate((p.min(axis=0), p.max(axis=0))) for p in points]
        if any((b[2:] - b[:2] < 1).any() for b in boxes):
            raise ValueError("框宽高必须至少为 1 像素")
        predictor.set_prompts({"bboxes": np.array(boxes, dtype=np.float32), "cls": classes})
    else:
        # 在有界分辨率绘制各个示例掩码，保持图像与掩码的坐标系一致。
        scale = min(1, 1536 / max(w, h))
        nw, nh = round(w * scale), round(h * scale)
        image = image.resize((nw, nh))
        masks = []
        for shape, pts in zip(shapes, points):
            coords = [(float(x * nw / w), float(y * nh / h)) for x, y in pts]
            mask = Image.new("L", (nw, nh))
            draw = ImageDraw.Draw(mask)
            radius = max(1, min(512, float(shape.get("radius", 24))) * scale)
            if shape["kind"] == "box":
                a = np.array(coords)
                draw.rectangle((*a.min(axis=0), *a.max(axis=0)), fill=255)
            elif shape["kind"] == "polygon" and len(coords) >= 3:
                draw.polygon(coords, fill=255)
            elif shape["kind"] in {"point", "brush"}:
                if shape["kind"] == "brush" and len(coords) > 1:
                    draw.line(coords, fill=255, width=round(radius * 2), joint="curve")
                for x, y in coords:
                    draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=255)
            else:
                raise ValueError("无效的标注形状")
            masks.append(np.array(mask))
        # 掩码与图像使用同一 LetterBox；显式保留 (N,H,W)，避免灰度通道扩维。
        letterbox = LetterBox(new_shape=(config["imgsz"], config["imgsz"]), auto=False)
        pixels = letterbox(image=np.array(image))
        aligned = np.stack([letterbox(image=mask).squeeze(-1) for mask in masks])
        aligned[aligned == 114] = 0
        tensor = torch.from_numpy(pixels.transpose(2, 0, 1).copy()).unsqueeze(0).to(predictor.device).float() / 255
        visual = LoadVisualPrompt().get_visuals(classes, tensor.shape[2:], masks=aligned)
        with torch.inference_mode():
            embeddings = predictor.model(tensor, vpe=visual.unsqueeze(0).to(predictor.device), return_vpe=True)
        model.set_classes(names, embeddings)
        return
    model.set_classes(names, predictor.get_vpe(image))


def run_job(job, config, items):
    started = time.monotonic()
    folder = RUNTIME / job["id"]
    folder.mkdir()
    model = None
    try:
        (folder / "request.json").write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
        job.update(status="running", message="加载权重（首次使用自动下载）")
        checkpoint = config["model"]
        if config["mode"] == "free":
            checkpoint = checkpoint.replace("-seg.pt", "-seg-pf.pt")
        model = YOLOE(checkpoint)
        device = config["device"]
        if device == "auto":
            device = "0" if torch.cuda.is_available() else "cpu"
        if config["mode"] == "text":
            job["message"] = "编码文本提示（首次使用可能下载文本编码器）"
            model.set_classes(config["names"])
        elif config["mode"] == "visual":
            job["message"] = "编码参考图与视觉区域"
            visual_embedding(model, config, device)
        if config["mode"] != "free":
            model.save_prompt_embeddings(folder / "prompt.npz")
        for i, key in enumerate(items):
            if job["cancel"]:
                break
            path = file_path(key)
            job["message"] = f"{i + 1} / {len(items)} · {path.name}"
            image = read_image(path)
            result = model.predict(
                image,
                device=device,
                imgsz=config["imgsz"],
                conf=config["conf"],
                iou=config["iou"],
                max_det=config["max_det"],
                verbose=False,
            )[0]
            rows = []
            polygons = result.masks.xy if result.masks is not None else []
            xywhn = result.boxes.xywhn.cpu().tolist()
            for j, box in enumerate(result.boxes.data.cpu().tolist()):
                cls = int(box[-1])
                rows.append(
                    {
                        "cls": cls,
                        "name": result.names[cls],
                        "conf": box[-2],
                        "box": box[:4],
                        "polygon": polygons[j].tolist() if len(polygons) > j else [],
                    }
                )
            record = {
                "image": key,
                "path": str(path),
                "size": list(image.size),
                "detections": rows,
                "speed": result.speed,
                "job": job["id"],
            }
            (folder / f"{key}.json").write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
            lines = [f"{r['cls']} " + " ".join(f"{v:.6f}" for v in b) for r, b in zip(rows, xywhn)]
            (folder / f"{key}.txt").write_text("\n".join(lines), encoding="utf-8")
            seg_lines = []
            for r in rows:
                if r["polygon"]:
                    normalized = np.array(r["polygon"]) / np.array(image.size)
                    seg_lines.append(f"{r['cls']} " + " ".join(f"{v:.6f}" for v in normalized.ravel()))
            (folder / f"{key}.seg.txt").write_text("\n".join(seg_lines), encoding="utf-8")
            Image.fromarray(result.plot(pil=False)[..., ::-1]).save(folder / f"{key}.jpg", quality=90)
            job["results"].append(
                {"image": key, "name": path.name, "count": len(rows), "ms": sum(result.speed.values())}
            )
            job["done"] += 1
        job.update(
            status="cancelled" if job["cancel"] else "done",
            message="已取消，已完成结果保留" if job["cancel"] else "推理完成",
        )
        (folder / "classes.json").write_text(json.dumps(model.names, ensure_ascii=False), encoding="utf-8")
    except Exception as exc:
        LOGGER.exception("YOLOE 推理任务失败")
        job.update(status="error", message=f"{type(exc).__name__}: {exc}")
    finally:
        job["elapsed"] = round(time.monotonic() - started, 2)
        job["output"] = str(folder)
        (folder / "job.json").write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
        del model
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        LOCK.release()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, data, content_type="application/json", status=200):
        if content_type == "application/json":
            data = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.headers.get("Host", "").split(":")[0] not in {"127.0.0.1", "localhost"}:
            self.send({"error": "仅允许本机访问"}, status=403)
            return
        try:
            self.get()
        except (ValueError, KeyError, OSError) as exc:
            self.send({"error": str(exc)}, status=400)

    def get(self):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path == "/api/status":
            self.send(
                {
                    "token": TOKEN,
                    "version": __version__,
                    "cuda": torch.cuda.is_available(),
                    "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU",
                    "models": MODELS,
                    "default_dir": ARGS.directory,
                    "output": str(RUNTIME),
                }
            )
        elif url.path == "/api/image":
            image = read_image(file_path(q["id"]))
            if q.get("thumb"):
                image.thumbnail((280, 180))
            buff = io.BytesIO()
            image.save(buff, "JPEG", quality=90)
            self.send(buff.getvalue(), "image/jpeg")
        elif url.path == "/api/jobs":
            self.send(list(JOBS.values())[::-1])
        elif url.path == "/api/result":
            job = JOBS[q["job"]]
            key = q["image"]
            if not any(r["image"] == key for r in job["results"]):
                raise ValueError("该图片尚无结果")
            self.send(json.loads((RUNTIME / job["id"] / f"{key}.json").read_text(encoding="utf-8")))
        elif url.path == "/api/download":
            job = JOBS[q["job"]]
            if job["status"] in {"queued", "running"}:
                raise ValueError("请在任务结束或取消后导出")
            folder = RUNTIME / job["id"]
            archive_path = RUNTIME / f"{job['id']}.zip"
            with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
                for path in folder.iterdir():
                    archive.write(path, path.name)
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Disposition", f'attachment; filename="yoloe-{job["id"]}.zip"')
            self.send_header("Content-Length", str(archive_path.stat().st_size))
            self.end_headers()
            with archive_path.open("rb") as stream:
                shutil.copyfileobj(stream, self.wfile)
        elif url.path == "/favicon.ico":
            self.send(b"", "image/x-icon", 204)
        elif url.path in {"/", "/index.html", "/app.js", "/style.css"}:
            path = BASE / ("index.html" if url.path == "/" else url.path[1:])
            self.send(path.read_bytes(), mimetypes.guess_type(str(path))[0] + "; charset=utf-8")
        else:
            self.send({"error": "未找到"}, status=404)

    def do_POST(self):
        if self.headers.get("X-Studio-Token") != TOKEN:
            self.send({"error": "请求过期，请刷新页面"}, status=403)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length > 4_000_000:
                raise ValueError("请求过大")
            data = json.loads(self.rfile.read(length))
            self.post(data)
        except (ValueError, KeyError, OSError, TypeError, subprocess.TimeoutExpired) as exc:
            self.send({"error": str(exc)}, status=400)

    def post(self, data):
        if self.path == "/api/open":
            root = Path(data["path"]).expanduser().resolve()
            if not root.is_dir():
                raise ValueError("目录不存在或不可访问")
            images = []
            paths = root.rglob("*") if data.get("recursive", True) else root.iterdir()
            for path in sorted(paths):
                if path.is_file() and path.suffix.lower() in EXTS:
                    key = hashlib.sha256(str(path).encode()).hexdigest()[:20]
                    FILES[key] = path
                    images.append({"id": key, "name": path.name, "relative": str(path.relative_to(root))})
            self.send({"path": str(root), "images": images})
        elif self.path == "/api/pick":
            code = "import tkinter as t; from tkinter import filedialog; r=t.Tk(); r.withdraw(); r.attributes('-topmost',True); print(filedialog.askdirectory()); r.destroy()"
            proc = subprocess.run(
                [sys.executable, "-c", code],
                capture_output=True,
                check=False,
                text=True,
                encoding="utf-8",
                env={**os.environ, "PYTHONIOENCODING": "utf-8"},
                timeout=180,
            )
            if proc.returncode:
                raise ValueError("系统选择器不可用，请直接粘贴目录路径")
            self.send({"path": proc.stdout.strip()})
        elif self.path == "/api/run":
            mode = data["mode"]
            if mode not in {"visual", "text", "free"} or data["model"] not in MODELS:
                raise ValueError("无效模式或模型")
            items = list(dict.fromkeys(data["images"]))
            if not items:
                raise ValueError("请先打开图片目录")
            for item in items:
                file_path(item)
            if data["device"] not in {"auto", "cpu", "0"}:
                raise ValueError("无效设备")
            data["imgsz"] = int(data["imgsz"])
            data["max_det"] = int(data["max_det"])
            data["conf"], data["iou"] = float(data["conf"]), float(data["iou"])
            if not (
                256 <= data["imgsz"] <= 1536
                and 1 <= data["max_det"] <= 3000
                and 0.01 <= data["conf"] <= 1
                and 0.01 <= data["iou"] <= 1
            ):
                raise ValueError("推理参数超出范围")
            if mode == "text" and (not data.get("names") or len(data["names"]) > 200):
                raise ValueError("请输入 1 至 200 个文本类别")
            if mode == "visual":
                file_path(data["reference"])
                data["reference_path"] = str(file_path(data["reference"]))
                if not data.get("shapes"):
                    raise ValueError("请先在参考图上标注")
            if not LOCK.acquire(blocking=False):
                raise ValueError("已有任务正在运行，请等待或取消")
            key = time.strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(3)
            job = {
                "id": key,
                "mode": mode,
                "status": "queued",
                "message": "准备中",
                "done": 0,
                "total": len(items),
                "results": [],
                "cancel": False,
                "model": data["model"],
            }
            JOBS[key] = job
            threading.Thread(target=run_job, args=(job, data, items), daemon=True).start()
            self.send(job)
        elif self.path == "/api/cancel":
            JOBS[data["id"]]["cancel"] = True
            self.send({"ok": True})
        else:
            self.send({"error": "未找到"}, status=404)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--directory", default=str(BASE.parents[1] / "ultralytics/assets"))
    parser.add_argument("--no-browser", action="store_true")
    ARGS = parser.parse_args()
    for path in sorted(RUNTIME.glob("*/job.json"), key=lambda p: p.stat().st_mtime)[-100:]:
        job = json.loads(path.read_text(encoding="utf-8"))
        JOBS[job["id"]] = job
    server = ThreadingHTTPServer(("127.0.0.1", ARGS.port), Handler)
    print(f"YOLOE 本地实验台 http://127.0.0.1:{ARGS.port}", flush=True)
    if not ARGS.no_browser:
        webbrowser.open(f"http://127.0.0.1:{ARGS.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
