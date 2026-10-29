const $ = (id) => document.getElementById(id);
const colors = ["#63dba7", "#ffc974", "#7bbaff", "#ed92ca", "#bea0ff", "#f8967a"];
const state = {
  images: [],
  current: null,
  reference: null,
  shapes: [],
  names: ["目标"],
  cls: 0,
  mode: "visual",
  tool: "box",
  referenceView: false,
  page: 0,
  zoom: 1,
  spaceHeld: false,
  pan: null,
  jobs: [],
  job: null,
  result: null,
  draft: null,
  drawing: false,
  token: "",
  loading: 0,
};
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let toastTimer;
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 6500);
}
async function api(path, data) {
  const response = await fetch(
    "/api/" + path,
    data === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Studio-Token": state.token },
          body: JSON.stringify(data),
        },
  );
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}
function safe(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (error) {
      toast(error.message);
    }
  };
}
function filtered() {
  const term = $("search").value.toLowerCase();
  return state.images.filter((i) => i.relative.toLowerCase().includes(term));
}
function renderLibrary() {
  const images = filtered(),
    pages = Math.ceil(images.length / 40);
  state.page = Math.max(0, Math.min(state.page, pages - 1));
  $("imageCount").textContent = `${state.images.length} 张`;
  $("batchCount").textContent = `(${state.images.length})`;
  $("pageLabel").textContent = `${pages ? state.page + 1 : 0} / ${pages}`;
  $("prevPage").disabled = state.page === 0;
  $("nextPage").disabled = state.page + 1 >= pages;
  const results = state.jobs.find((j) => j.id === state.job)?.results || [];
  $("imageList").innerHTML =
    images
      .slice(state.page * 40, state.page * 40 + 40)
      .map((i) => {
        const r = results.find((r) => r.image === i.id);
        return `<button class="image-item ${state.current?.id === i.id ? "active" : ""}" data-image="${i.id}" title="${esc(i.relative)}"><img loading="lazy" src="/api/image?id=${i.id}&thumb=1" alt=""><div><strong>${esc(i.name)}</strong><small>${r ? `${r.count} 个目标` : state.reference?.id === i.id ? "参考图" : "待测图片"}</small></div></button>`;
      })
      .join("") || '<div class="empty">没有找到图片</div>';
  $("imageList")
    .querySelectorAll("[data-image]")
    .forEach((b) => (b.onclick = safe(() => selectImage(b.dataset.image))));
}
function updateLibraryResults() {
  const results = state.jobs.find((j) => j.id === state.job)?.results || [];
  document.querySelectorAll("[data-image]").forEach((button) => {
    const result = results.find((r) => r.image === button.dataset.image);
    button.querySelector("small").textContent = result
      ? `${result.count} 个目标`
      : state.reference?.id === button.dataset.image
        ? "参考图"
        : "待测图片";
  });
}
async function openDirectory() {
  $("openDir").disabled = true;
  $("openDir").textContent = "读取中…";
  try {
    const data = await api("open", { path: $("directory").value, recursive: $("recursive").checked });
    state.images = data.images;
    state.page = 0;
    $("search").value = "";
    state.current = null;
    $("directory").value = data.path;
    localStorage.setItem("yoloe-directory", data.path);
    renderLibrary();
    if (state.images.length) await selectImage(state.images[0].id);
    else {
      state.width = 0;
      state.height = 0;
      endPan();
      state.referenceView = false;
      state.result = null;
      $("imageWrap").hidden = true;
      $("canvasEmpty").hidden = false;
      $("imageName").textContent = "目录中没有支持的图片";
      $("imageMeta").textContent = "";
      renderResult();
      toast("没有找到支持的图片，可尝试勾选“含子目录”");
    }
  } finally {
    $("openDir").disabled = false;
    $("openDir").textContent = "打开目录";
  }
}
async function selectImage(id) {
  state.current = state.images.find((i) => i.id === id);
  state.referenceView = false;
  state.result = null;
  renderLibrary();
  await showImage();
  await loadResult();
}
async function showImage() {
  const item = state.referenceView ? state.reference : state.current;
  if (!item) return;
  state.draft = null;
  state.drawing = false;
  endPan();
  const seq = ++state.loading;
  $("targetTab").classList.toggle("active", !state.referenceView);
  $("referenceTab").classList.toggle("active", state.referenceView);
  $("imageName").textContent = item.name;
  state.width = 0;
  state.height = 0;
  $("imageWrap").hidden = true;
  $("imageMeta").textContent = "正在载入图片…";
  $("overlay").innerHTML = "";
  const image = new Image();
  image.src = "/api/image?id=" + item.id;
  try {
    await image.decode();
  } catch {
    if (seq === state.loading) $("imageMeta").textContent = "图片读取失败，请选择其他图片";
    throw new Error("无法读取该图片，请检查文件是否损坏");
  }
  if (seq !== state.loading) return;
  $("mainImage").src = image.src;
  state.width = image.naturalWidth;
  state.height = image.naturalHeight;
  $("imageMeta").textContent = `${state.width} × ${state.height} px · ${state.referenceView ? "参考图" : "待测图片"}`;
  $("overlay").setAttribute("viewBox", `0 0 ${state.width} ${state.height}`);
  $("canvasEmpty").hidden = true;
  $("imageWrap").hidden = false;
  state.zoom = 1;
  resize();
  $("viewport").scrollTo(0, 0);
  renderOverlay();
  updateHint();
}
function resize() {
  if (!state.width) return;
  const v = $("viewport");
  const scale = Math.min((v.clientWidth - 30) / state.width, (v.clientHeight - 30) / state.height) * state.zoom;
  $("imageWrap").style.width = `${state.width * scale}px`;
  $("imageWrap").style.height = `${state.height * scale}px`;
  $("zoomFit").textContent = state.zoom === 1 ? "适应" : `${Math.round(state.zoom * 100)}%`;
  $("viewport").classList.toggle("pan-ready", state.spaceHeld && state.zoom > 1);
}
function setZoom(zoom, clientX, clientY) {
  if (!state.width || state.drawing || state.pan) return;
  const viewport = $("viewport"),
    bounds = viewport.getBoundingClientRect();
  clientX ??= bounds.left + viewport.clientWidth / 2;
  clientY ??= bounds.top + viewport.clientHeight / 2;
  const before = $("imageWrap").getBoundingClientRect();
  const x = (clientX - before.left) / before.width,
    y = (clientY - before.top) / before.height;
  state.zoom = Math.max(0.25, Math.min(16, zoom));
  resize();
  const after = $("imageWrap").getBoundingClientRect();
  viewport.scrollLeft += after.left + x * after.width - clientX;
  viewport.scrollTop += after.top + y * after.height - clientY;
}
function endPan() {
  const viewport = $("viewport"),
    pointer = state.pan?.pointerId;
  state.pan = null;
  viewport.classList.remove("panning");
  if (pointer !== undefined && viewport.hasPointerCapture(pointer)) viewport.releasePointerCapture(pointer);
}
$("viewport").addEventListener(
  "wheel",
  (e) => {
    if (!state.width) return;
    e.preventDefault();
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? $("viewport").clientHeight : 1);
    setZoom(state.zoom * Math.exp(-delta * 0.0015), e.clientX, e.clientY);
  },
  { passive: false },
);
$("viewport").addEventListener(
  "pointerdown",
  (e) => {
    const viewport = $("viewport");
    if (e.button === 0) viewport.focus({ preventScroll: true });
    if (e.button !== 0 || !state.spaceHeld || state.zoom <= 1 || state.drawing || !state.width) return;
    e.preventDefault();
    e.stopPropagation();
    state.pan = {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
    };
    viewport.setPointerCapture(e.pointerId);
    viewport.classList.add("panning");
  },
  true,
);
$("viewport").addEventListener(
  "pointermove",
  (e) => {
    if (!state.pan || state.pan.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    $("viewport").scrollLeft = state.pan.left + state.pan.x - e.clientX;
    $("viewport").scrollTop = state.pan.top + state.pan.y - e.clientY;
  },
  true,
);
["pointerup", "pointercancel", "lostpointercapture"].forEach((event) => {
  $("viewport").addEventListener(event, () => endPan());
});
function setReference() {
  if (!state.current) return toast("请先选择图片");
  if (
    state.reference?.id !== state.current.id &&
    state.shapes.length &&
    !confirm("切换参考图会清除现有标注，是否继续？")
  )
    return;
  if (state.reference?.id !== state.current.id) state.shapes = [];
  state.reference = { ...state.current };
  state.referenceView = true;
  renderReference();
  renderShapes();
  safe(showImage)();
  renderLibrary();
}
function renderReference() {
  $("referenceCard").innerHTML = state.reference
    ? `<button id="editReference" title="打开参考图标注"><img src="/api/image?id=${state.reference.id}&thumb=1" alt="参考图"><span>${esc(state.reference.name)}<br>点击继续标注</span></button>`
    : "<p>选择图片后，点击“使用当前图片”</p>";
  if ($("editReference"))
    $("editReference").onclick = safe(async () => {
      state.referenceView = true;
      await showImage();
    });
}
function renderClasses() {
  $("classes").innerHTML = state.names
    .map(
      (n, i) =>
        `<div class="class-row ${state.cls === i ? "selected" : ""}"><button data-class="${i}" title="选择类别 ${i}"><span class="swatch" style="background:${colors[i % colors.length]}"></span> ${i}</button><input aria-label="类别 ${i} 名称" data-name="${i}" value="${esc(n)}"><button class="delete" data-delete-class="${i}" title="删除类别">删除</button></div>`,
    )
    .join("");
  $("classes")
    .querySelectorAll("[data-class]")
    .forEach(
      (b) =>
        (b.onclick = () => {
          state.cls = +b.dataset.class;
          renderClasses();
        }),
    );
  $("classes")
    .querySelectorAll("[data-name]")
    .forEach(
      (i) =>
        (i.oninput = () => {
          state.names[+i.dataset.name] = i.value;
        }),
    );
  $("classes")
    .querySelectorAll("[data-delete-class]")
    .forEach(
      (b) =>
        (b.onclick = () => {
          if (state.names.length === 1) return toast("至少保留一个类别");
          const index = +b.dataset.deleteClass;
          state.names.splice(index, 1);
          state.shapes = state.shapes
            .filter((s) => s.cls !== index)
            .map((s) => ({ ...s, cls: s.cls > index ? s.cls - 1 : s.cls }));
          state.cls = Math.min(state.cls, state.names.length - 1);
          renderClasses();
          renderShapes();
          renderOverlay();
        }),
    );
}
function renderShapes() {
  const kindNames = { box: "框", point: "区域点", brush: "画笔", polygon: "多边形" };
  $("shapeList").innerHTML = state.shapes
    .map(
      (s, i) =>
        `<div class="shape-row"><span>${i + 1}. ${esc(state.names[s.cls])} · ${kindNames[s.kind]}</span><button data-delete="${i}">删除</button></div>`,
    )
    .join("");
  $("shapeList")
    .querySelectorAll("[data-delete]")
    .forEach(
      (b) =>
        (b.onclick = () => {
          state.shapes.splice(+b.dataset.delete, 1);
          renderShapes();
          renderOverlay();
        }),
    );
}
function shapeSvg(s) {
  const color = colors[s.cls % colors.length],
    pts = s.points,
    style = `stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"`;
  if (s.kind === "box") {
    const x = Math.min(pts[0][0], pts[1][0]),
      y = Math.min(pts[0][1], pts[1][1]);
    return `<rect x="${x}" y="${y}" width="${Math.abs(pts[0][0] - pts[1][0])}" height="${Math.abs(pts[0][1] - pts[1][1])}" fill="${color}" fill-opacity=".12" ${style}/>`;
  }
  if (s.kind === "point")
    return `<circle cx="${pts[0][0]}" cy="${pts[0][1]}" r="${s.radius}" fill="${color}" fill-opacity=".3" ${style}/>`;
  if (s.kind === "brush")
    return `<polyline points="${pts.map((p) => p.join(",")).join(" ")}" fill="none" stroke="${color}" stroke-opacity=".45" stroke-width="${s.radius * 2}" stroke-linejoin="round" stroke-linecap="round"/>`;
  return `<polygon points="${pts.map((p) => p.join(",")).join(" ")}" fill="${color}" fill-opacity=".18" ${style}/>`;
}
function renderOverlay() {
  let svg = "";
  if (!state.referenceView && state.result && state.result.image === state.current?.id) {
    const font = Math.max(12, state.width / 90);
    for (const row of state.result.detections) {
      const color = colors[row.cls % colors.length],
        b = row.box;
      if ($("showMasks").checked && row.polygon.length)
        svg += `<polygon points="${row.polygon.map((p) => p.join(",")).join(" ")}" fill="${color}" fill-opacity=".28"/>`;
      if ($("showBoxes").checked)
        svg += `<rect x="${b[0]}" y="${b[1]}" width="${b[2] - b[0]}" height="${b[3] - b[1]}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/><text x="${b[0] + 3}" y="${Math.max(font, b[1] - 5)}" fill="${color}" stroke="#13221b" stroke-width="3" paint-order="stroke" font-size="${font}">${esc(row.name)} ${(row.conf * 100).toFixed(0)}%</text>`;
    }
  }
  const displayed = state.referenceView ? state.reference : state.current;
  if ($("showPrompts").checked && displayed?.id === state.reference?.id && state.mode === "visual")
    svg += state.shapes.map(shapeSvg).join("");
  if (state.draft) svg += shapeSvg(state.draft);
  $("overlay").innerHTML = svg;
}
function coordinate(e) {
  const rect = $("overlay").getBoundingClientRect();
  return [
    Math.max(0, Math.min(state.width, ((e.clientX - rect.left) / rect.width) * state.width)),
    Math.max(0, Math.min(state.height, ((e.clientY - rect.top) / rect.height) * state.height)),
  ];
}
function canDraw() {
  if (state.mode !== "visual") {
    toast("切换到视觉模式后可以标注");
    return false;
  }
  if (!state.reference) {
    setReference();
    return false;
  }
  if (!state.referenceView) {
    toast("请点击“参考图标注”后绘制");
    return false;
  }
  return true;
}
$("overlay").onpointerdown = (e) => {
  if (e.button !== 0 || state.spaceHeld || !canDraw()) return;
  const p = coordinate(e),
    shape = { kind: state.tool, cls: state.cls, radius: +$("radius").value, points: [p] };
  if (state.tool === "polygon") {
    if (!state.draft) state.draft = shape;
    else state.draft.points.push(p);
    renderOverlay();
    return;
  }
  if (state.tool === "point") {
    state.shapes.push(shape);
    renderShapes();
    renderOverlay();
    return;
  }
  state.draft = shape;
  state.drawing = true;
  if (state.tool === "box") shape.points.push(p);
  $("overlay").setPointerCapture(e.pointerId);
  renderOverlay();
};
$("overlay").onpointermove = (e) => {
  if (!state.drawing || !state.draft) return;
  const p = coordinate(e);
  if (state.tool === "box") state.draft.points[1] = p;
  else if (Math.hypot(p[0] - state.draft.points.at(-1)[0], p[1] - state.draft.points.at(-1)[1]) > 2)
    state.draft.points.push(p);
  renderOverlay();
};
$("overlay").onpointerup = () => {
  if (!state.drawing) return;
  state.drawing = false;
  const s = state.draft;
  if (
    s &&
    (s.kind !== "box" ||
      (Math.abs(s.points[1][0] - s.points[0][0]) >= 2 && Math.abs(s.points[1][1] - s.points[0][1]) >= 2))
  )
    state.shapes.push(s);
  state.draft = null;
  renderShapes();
  renderOverlay();
};
$("overlay").onpointercancel = () => {
  state.drawing = false;
  state.draft = null;
  renderOverlay();
};
$("overlay").ondblclick = (e) => {
  e.preventDefault();
  if (state.spaceHeld) return;
  if (state.tool === "polygon" && state.draft?.points.length >= 3) {
    state.shapes.push(state.draft);
    state.draft = null;
    renderShapes();
    renderOverlay();
  }
};
function updateHint() {
  const hints = {
    box: "拖动框选 · 同类示例可重复标注",
    point: "点击添加圆形区域 · 半径以原图像素计",
    brush: "按住拖动涂抹目标区域",
    polygon: "连续点击边界 · 双击完成 · Esc 取消",
  };
  $("canvasHint").textContent = state.referenceView ? hints[state.tool] : "切换目标图片不会改变参考提示";
  $("toolHint").textContent = {
    box: "原生矩形框提示。紧贴目标，减少无关背景。",
    point: "点选转换为圆形掩码，不是 SAM 正负点。调节半径，使区域覆盖目标特征。",
    brush: "涂抹生成区域掩码，通过官方视觉提示编码器提取特征。",
    polygon: "闭合边界内部填充为掩码，双击完成绘制。",
  }[state.tool];
}
document.querySelectorAll("[data-tool]").forEach(
  (b) =>
    (b.onclick = (e) => {
      state.tool = b.dataset.tool;
      state.draft = null;
      state.drawing = false;
      document.querySelectorAll("[data-tool]").forEach((x) => x.classList.toggle("active", x === b));
      updateHint();
      renderOverlay();
      if (e.detail) $("viewport").focus({ preventScroll: true });
    }),
);
document.querySelectorAll("[data-mode]").forEach(
  (b) =>
    (b.onclick = () => {
      state.mode = b.dataset.mode;
      document.querySelectorAll("[data-mode]").forEach((x) => {
        x.classList.toggle("active", x === b);
        x.setAttribute("aria-selected", String(x === b));
      });
      ["visual", "text", "free"].forEach((m) => ($(m + "Panel").hidden = m !== state.mode));
      state.draft = null;
      state.referenceView = false;
      renderModels();
      safe(showImage)();
    }),
);
function renderModels() {
  const value = $("model").value || "yoloe-26n-seg.pt";
  $("model").innerHTML = state.models
    .map((m) => `<option value="${m}">${m.replace("-seg.pt", state.mode === "free" ? "-seg-pf" : "-seg")}</option>`)
    .join("");
  $("model").value = value;
}
function renderResult() {
  const r = state.result;
  $("resultCount").textContent = r ? `· ${r.detections.length} 个目标` : "";
  $("resultTime").textContent = r
    ? `${Object.values(r.speed)
        .reduce((a, b) => a + b, 0)
        .toFixed(1)} ms / 图`
    : "尚未推理";
  $("resultList").innerHTML = r
    ? r.detections
        .map(
          (d) =>
            `<div class="detection"><span class="swatch" style="background:${colors[d.cls % colors.length]}"></span>${esc(d.name)}<small>${(d.conf * 100).toFixed(1)}%</small></div>`,
        )
        .join("") || '<p class="muted">没有检测到目标。可调整提示或置信度后重试。</p>'
    : '<p class="muted">推理完成后，在这里查看类别、置信度与耗时。</p>';
  renderOverlay();
}
async function loadResult() {
  const image = state.current?.id,
    job = state.jobs.find((j) => j.id === state.job);
  if (!image || !job?.results.some((r) => r.image === image)) {
    state.result = null;
    renderResult();
    return;
  }
  const result = await api(`result?job=${job.id}&image=${image}`);
  if (state.current?.id === image && state.job === job.id) {
    state.result = result;
    renderResult();
  }
}
async function run(all) {
  if (!state.current) return toast("请先打开图片目录");
  if (state.draft) return toast("请先完成当前标注，或按 Esc 取消");
  const names =
    state.mode === "text"
      ? $("textClasses")
          .value.split(/[,，\n]/)
          .map((s) => s.trim())
          .filter(Boolean)
      : state.names.map((s) => s.trim());
  if (state.mode === "visual" && (!state.reference || !state.shapes.length)) return toast("请先固定参考图并标注目标");
  if (state.mode === "visual" && names.some((n, i) => !n || !state.shapes.some((s) => s.cls === i)))
    return toast("每个类别都需要名称和至少一个示例");
  if (state.mode === "text" && !names.length) return toast("请输入至少一个类别");
  const job = await api("run", {
    mode: state.mode,
    model: $("model").value,
    device: $("device").value,
    imgsz: +$("imgsz").value,
    conf: +$("confidence").value,
    iou: +$("iou").value,
    max_det: +$("maxDet").value,
    names,
    reference: state.reference?.id,
    shapes: state.shapes,
    images: all ? state.images.map((i) => i.id) : [state.current.id],
  });
  state.job = job.id;
  state.result = null;
  state.referenceView = false;
  await showImage();
  renderResult();
  await poll();
}
function renderJobs() {
  const scroll = $("jobsList").scrollTop;
  const running = state.jobs.some((j) => ["queued", "running"].includes(j.status));
  $("runOne").disabled = $("runAll").disabled = running;
  $("jobSummary").textContent = running ? "任务进行中 · 可以继续浏览图片" : "结果自动保存到本地";
  $("jobsList").innerHTML =
    state.jobs
      .map(
        (j) =>
          `<div class="job ${j.status}"><div class="job-title">${{ visual: "视觉提示", text: "文本提示", free: "无提示" }[j.mode]} · ${j.done} / ${j.total}<small>${esc(j.id)}</small></div><div class="job-progress"><p title="${esc(j.message)}">${esc(j.message)}</p><progress max="${j.total}" value="${j.done}"></progress>${j.status === "error" ? `<details><summary>错误详情</summary><pre>${esc(j.message)}</pre></details>` : ""}</div><div class="job-actions"><button data-view-job="${j.id}">${state.job === j.id ? "正在查看" : "查看结果"}</button>${["queued", "running"].includes(j.status) ? `<button data-cancel="${j.id}">${j.cancel ? "正在停止…" : "取消"}</button>` : `<a href="/api/download?job=${j.id}" download="yoloe-${j.id}.zip">导出 ZIP</a>`}</div></div>`,
      )
      .join("") || '<p class="muted">还没有推理任务。先用一张图片验证，再批量运行。</p>';
  $("jobsList").scrollTop = scroll;
  $("jobsList")
    .querySelectorAll("[data-cancel]")
    .forEach(
      (b) =>
        (b.onclick = safe(async () => {
          await api("cancel", { id: b.dataset.cancel });
          await poll();
        })),
    );
  $("jobsList")
    .querySelectorAll("[data-view-job]")
    .forEach(
      (b) =>
        (b.onclick = safe(async () => {
          state.job = b.dataset.viewJob;
          await loadResult();
          renderLibrary();
          renderJobs();
          toast("已切换结果记录。当前参数不会被历史任务覆盖。");
        })),
    );
}
let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    state.jobs = await api("jobs");
    $("deviceBadge").textContent = state.gpu || "本地服务";
    $("deviceBadge").classList.remove("offline");
    renderJobs();
    if (!state.result || state.result.job !== state.job) await loadResult();
    updateLibraryResults();
  } finally {
    polling = false;
  }
}
function download(data, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("savePrompt").onclick = () => {
  if (!state.reference || !state.shapes.length) return toast("请先完成参考标注");
  download(
    { version: 1, reference: state.reference, names: state.names, shapes: state.shapes },
    "yoloe-visual-prompt.json",
  );
};
$("loadPrompt").onclick = () => $("promptFile").click();
$("promptFile").onchange = safe(async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const p = JSON.parse(await file.text());
    if (
      p.version !== 1 ||
      !Array.isArray(p.names) ||
      !p.names.length ||
      !Array.isArray(p.shapes) ||
      p.shapes.length > 256 ||
      !state.images.some((i) => i.id === p.reference?.id)
    )
      throw new Error("提示文件不匹配。请先打开包含原参考图的目录，再载入提示。");
    if (
      p.names.some((n) => typeof n !== "string") ||
      p.shapes.some(
        (s) =>
          !["box", "point", "brush", "polygon"].includes(s.kind) ||
          !Number.isInteger(s.cls) ||
          s.cls < 0 ||
          s.cls >= p.names.length ||
          !Array.isArray(s.points) ||
          !s.points.length ||
          s.points.some((pt) => !Array.isArray(pt) || pt.length !== 2 || pt.some((v) => !Number.isFinite(v))) ||
          !Number.isFinite(s.radius),
      )
    )
      throw new Error("提示文件含无效形状");
    state.reference = state.images.find((i) => i.id === p.reference.id);
    state.names = p.names;
    state.shapes = p.shapes;
    state.cls = 0;
    state.referenceView = true;
    renderClasses();
    renderReference();
    renderShapes();
    await showImage();
    toast("已载入提示");
  } finally {
    e.target.value = "";
  }
});
$("openDir").onclick = safe(openDirectory);
$("directory").onkeydown = (e) => {
  if (e.key === "Enter") safe(openDirectory)();
};
$("pickDir").onclick = safe(async () => {
  const p = await api("pick", {});
  if (p.path) {
    $("directory").value = p.path;
    await openDirectory();
  }
});
$("search").oninput = () => {
  state.page = 0;
  renderLibrary();
};
$("prevPage").onclick = () => {
  state.page--;
  renderLibrary();
};
$("nextPage").onclick = () => {
  state.page++;
  renderLibrary();
};
$("pinReference").onclick = setReference;
$("referenceTab").onclick = safe(async () => {
  if (!state.reference) return setReference();
  state.referenceView = true;
  await showImage();
});
$("targetTab").onclick = safe(async () => {
  state.referenceView = false;
  await showImage();
});
$("addClass").onclick = () => {
  state.names.push(`目标 ${state.names.length + 1}`);
  state.cls = state.names.length - 1;
  renderClasses();
};
$("undo").onclick = () => {
  if (state.draft) {
    state.draft = null;
    state.drawing = false;
  } else state.shapes.pop();
  renderShapes();
  renderOverlay();
};
$("clear").onclick = () => {
  if (state.shapes.length && !confirm("清空当前参考图的所有标注？")) return;
  state.shapes = [];
  state.draft = null;
  renderShapes();
  renderOverlay();
};
$("zoomIn").onclick = (e) => {
  setZoom(state.zoom * 1.25);
  if (e.detail) $("viewport").focus({ preventScroll: true });
};
$("zoomOut").onclick = (e) => {
  setZoom(state.zoom / 1.25);
  if (e.detail) $("viewport").focus({ preventScroll: true });
};
$("zoomFit").onclick = (e) => {
  setZoom(1);
  $("viewport").scrollTo(0, 0);
  if (e.detail) $("viewport").focus({ preventScroll: true });
};
$("focusCanvas").onclick = (e) => {
  const focused = document.body.classList.toggle("canvas-focus");
  $("focusCanvas").textContent = focused ? "退出专注" : "专注画布";
  $("focusCanvas").setAttribute("aria-pressed", String(focused));
  if (e.detail) $("viewport").focus({ preventScroll: true });
};
$("radius").oninput = () => ($("radiusValue").value = $("radius").value);
$("confidence").oninput = () => ($("confidenceValue").value = (+$("confidence").value).toFixed(2));
["showBoxes", "showMasks", "showPrompts"].forEach((id) => ($(id).onchange = renderOverlay));
$("runOne").onclick = safe(() => run(false));
$("runAll").onclick = safe(() => run(true));
$("helpBtn").onclick = () => $("help").showModal();
$("closeHelp").onclick = () => $("help").close();
document.addEventListener("keydown", (e) => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) || e.target.isContentEditable || $("help").open)
    return;
  if (e.code === "Space") {
    if (e.target.closest('button, summary, a[href], [role="button"]')) return;
    e.preventDefault();
    state.spaceHeld = true;
    $("viewport").classList.toggle("pan-ready", state.zoom > 1);
  }
  if (e.key === "Escape") {
    state.draft = null;
    state.drawing = false;
    renderOverlay();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "z") {
    e.preventDefault();
    $("undo").click();
  }
  if (["ArrowLeft", "ArrowRight"].includes(e.key) && state.current) {
    const i = state.images.findIndex((x) => x.id === state.current.id) + (e.key === "ArrowRight" ? 1 : -1);
    if (state.images[i]) safe(() => selectImage(state.images[i].id))();
  }
});
document.addEventListener("keyup", (e) => {
  if (e.code !== "Space") return;
  state.spaceHeld = false;
  $("viewport").classList.remove("pan-ready");
  endPan();
});
window.addEventListener("blur", () => {
  state.spaceHeld = false;
  $("viewport").classList.remove("pan-ready");
  endPan();
});
new ResizeObserver(resize).observe($("viewport"));
safe(async () => {
  const env = await api("status");
  state.token = env.token;
  state.models = env.models;
  state.gpu = env.gpu;
  renderModels();
  renderClasses();
  $("deviceBadge").textContent = env.gpu;
  $("environment").textContent = `Ultralytics ${env.version} · ${env.gpu} · 结果目录：${env.output}`;
  $("directory").value = localStorage.getItem("yoloe-directory") || env.default_dir;
  await poll();
  if ($("directory").value) await openDirectory();
})();
setInterval(
  () =>
    poll().catch(() => {
      $("deviceBadge").textContent = "连接中断 · 请检查服务";
      $("deviceBadge").classList.add("offline");
    }),
  1800,
);
