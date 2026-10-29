const VIEW_KEY = "sakura-view-v4";
const SORT_KEY = "sakura-sort-v1";
const THEME_KEY = "sakura-theme";
const SITE_TITLE = "Sakura Drive";
const VIEWS = ["detail", "grid"];
const SORTS = ["name", "time", "size"];

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

function readSort() {
  try {
    const v = JSON.parse(localStorage.getItem(SORT_KEY) || "{}");
    return {
      by: SORTS.includes(v.by) ? v.by : "name",
      dir: v.dir === -1 ? -1 : 1,
    };
  } catch (e) {
    return { by: "name", dir: 1 };
  }
}

const state = {
  view: VIEWS.includes(localStorage.getItem(VIEW_KEY)) ? localStorage.getItem(VIEW_KEY) : "detail",
  sort: readSort(),
  path: [],
  file: null,
  meta: null,
  first: true,
  folders: [],
  files: [],
  query: "",
  results: null,
  lockedDir: null,
};

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));

function fmtSize(n) {
  if (n == null || n === "") return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  n = Number(n) || 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return (i === 0 ? n : n.toFixed(1)) + " " + u[i];
}

function fmtDate(s) {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return String(s);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function ago(ts) {
  if (!ts) return "未知";
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return m + " 分钟前";
  const h = Math.floor(m / 60);
  if (h < 24) return h + " 小时前";
  return Math.floor(h / 24) + " 天前";
}

const IMG = { png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, bmp: 1, svg: 1, avif: 1, ico: 1 };
const extOf = (name) => (String(name).split(".").pop() || "").toLowerCase();
const isImg = (name) => !!IMG[extOf(name)];

const ICONS = {
  pdf: "📕", doc: "📘", docx: "📘", xls: "📗", xlsx: "📗", csv: "📗",
  ppt: "📙", pptx: "📙", txt: "📄", md: "📝", json: "📜", js: "📜",
  ts: "📜", html: "🌐", css: "🎨", zip: "🗜️", rar: "🗜️", "7z": "🗜️",
  mp4: "🎬", mkv: "🎬", mov: "🎬", avi: "🎬", flv: "🎬", mp3: "🎵",
  wav: "🎵", flac: "🎵", exe: "⚙️", apk: "📱", iso: "💿", dmg: "💿",
  png: "🖼️", jpg: "🖼️", jpeg: "🖼️", gif: "🖼️", webp: "🖼️", svg: "🖼️",
};
const iconFor = (name) => ICONS[extOf(name)] || "📄";

const FOLDER_CATS = [
  { key: "game", re: /(游戏|game|steam)/i, ic: "🎮" },
  { key: "img", re: /(图片|照片|相册|壁纸|插画|截图|image|photo|pic|img|gallery)/i, ic: "🖼️" },
  { key: "video", re: /(视频|影片|影视|电影|movie|video|film)/i, ic: "🎬" },
  { key: "audio", re: /(音乐|音频|歌曲|music|audio|sound|podcast)/i, ic: "🎵" },
  { key: "design", re: /(美化|主题|皮肤|设计|theme|skin|design|icon)/i, ic: "🎨" },
  { key: "doc", re: /(文档|资料|书|教程|笔记|手册|pdf|doc|book|note)/i, ic: "📚" },
  { key: "system", re: /(系统|驱动|system|android|linux|windows|macos|win(?:7|8|10|11|xp))/i, ic: "🖥️" },
  { key: "code", re: /(代码|开发|源码|项目|前端|后端|code|dev|source|script|web|git)/i, ic: "💻" },
  { key: "app", re: /(软件|工具|程序|应用|安装|app|tool|setup|exe)/i, ic: "🧰" },
  { key: "archive", re: /(备份|归档|存档|压缩|历史|私人|私密|backup|archive|zip|old)/i, ic: "🗂️" },
  { key: "cloud", re: /(云|网盘|cloud|drive|storage)/i, ic: "☁️" },
];

function folderCat(name) {
  for (const c of FOLDER_CATS) if (c.re.test(name)) return c;
  return { key: "default", ic: "📁" };
}

const segOf = (p) => encodeURIComponent(p.id) + "|" + encodeURIComponent(p.name);

function parseSeg(seg) {
  // 必须先整体解码再找分隔符：文件名里的 | 会被编码成 %7C，先切会把名字截断
  let dec = seg;
  try {
    dec = decodeURIComponent(seg);
  } catch (e) {}
  const isFile = dec.startsWith("!");
  if (isFile) dec = dec.slice(1);
  const at = dec.indexOf("|");
  const item = at < 0 ? { id: dec, name: "" } : { id: dec.slice(0, at), name: dec.slice(at + 1) };
  item.file = isFile;
  return item;
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const segs = raw.split("/").filter(Boolean).map(parseSeg);
  const last = segs[segs.length - 1];
  if (last && last.file) {
    segs.pop();
    return { path: segs, file: { id: last.id, name: last.name } };
  }
  return { path: segs, file: null };
}

function writePath(path) {
  const hash = "#/" + path.map(segOf).join("/");
  if (location.hash === hash) route();
  else location.hash = hash;
}

function writeFile(id, name) {
  const hash =
    "#/" +
    state.path.map(segOf).concat("!" + encodeURIComponent(id) + "|" + encodeURIComponent(name)).join("/");
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function api(path, options) {
  const r = await fetch("/api/" + path, {
    headers: { accept: "application/json" },
    ...options,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok && !d.locked) {
    throw new Error(d.message || d.error || "HTTP " + r.status);
  }
  return d;
}

function setBusy(loading) {
  const sk = $("#skeleton");
  const listing = $("#listing");
  if (loading) {
    if (state.first) {
      sk.hidden = false;
      listing.hidden = true;
    }
    listing.classList.add("dim");
  } else {
    sk.hidden = true;
    listing.classList.remove("dim");
  }
}

function renderError(e) {
  const msg = e && e.message ? e.message : "未知错误";
  $("#err-msg").textContent = /cookie|401|403/i.test(msg)
    ? msg + "（Cookie 可能失效，更新 KV 的 COOKIE 后刷新即可）"
    : msg;
  $("#error").hidden = false;
  $("#listing").hidden = true;
  $("#skeleton").hidden = true;
  $("#about").hidden = true;
  $("#pathbar").hidden = true;
  $("#dir-sub").textContent = "读取失败";
}

function renderCrumb() {
  const bc = $("#breadcrumb");
  const items = [{ name: "根目录" }].concat(state.path.map((p) => ({ id: p.id, name: p.name })));
  const tail = state.file ? `<span class="crumb-cur" aria-current="page">${esc(state.file.name)}</span>` : "";
  bc.innerHTML =
    items
      .map((it, i) => {
        const last = i === items.length - 1 && !state.file;
        const label = esc(it.name);
        if (last) return `<span class="crumb-cur" aria-current="page">${label}</span>`;
        return `<a class="crumb" href="#" data-i="${i}">${label}</a><span class="crumb-sep">/</span>`;
      })
      .join("") + tail;
  $$("a.crumb", bc).forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      writePath(state.path.slice(0, Number(a.dataset.i)));
    };
  });
  const cur = $(".crumb-cur", bc);
  if (cur) cur.scrollIntoView({ block: "nearest", inline: "end" });
}

function renderHead(counts, cached) {
  const cur = state.path[state.path.length - 1];
  const title = cur ? cur.name : "Sakura Drive";
  $("#dir-title").textContent = title;
  $("#dir-sub").textContent = counts
    ? `${counts.folders} 个文件夹 · ${counts.files} 个文件`
    : "正在读取云端目录…";
  const badge = $("#badge-cache");
  if (cached === undefined || cached === null) badge.hidden = true;
  else {
    badge.hidden = false;
    badge.textContent = cached ? "缓存" : "实时";
    badge.className = "badge " + (cached ? "badge-ok" : "badge-wait badge-blink");
    badge.title = cached ? "命中目录缓存（90 秒）" : "直接回源 Teambition";
  }
  document.title = cur ? title + " · " + SITE_TITLE : SITE_TITLE;
  $("#about").hidden = state.path.length > 0;
}

function sortLists(folders, files) {
  const { by, dir } = state.sort;
  const cmp = (a, b, key) => {
    if (key === "size") return (a.size || 0) - (b.size || 0);
    if (key === "time") return new Date(a.updated || 0) - new Date(b.updated || 0);
    return String(a.name).localeCompare(String(b.name), "zh-Hans-CN", { numeric: true });
  };
  const order = (arr, key) => arr.slice().sort((a, b) => cmp(a, b, key) * dir);
  return { folders: order(folders, by === "size" ? "name" : by), files: order(files, by) };
}

function sortLabel() {
  const m = { name: "名称", time: "时间", size: "大小" };
  return m[state.sort.by] + (state.sort.dir === 1 ? " ↑" : " ↓");
}

function markSort() {
  $("#btn-sort").textContent = sortLabel().replace(" ↑", "↑").replace(" ↓", "↓");
  $("#btn-sort").title = "排序：按" + sortLabel();
  $$("#sort-menu [data-by]").forEach((b) => {
    b.classList.toggle("on", b.dataset.by === state.sort.by);
  });
  $$("#sort-menu [data-dir]").forEach((b) => {
    b.classList.toggle("on", Number(b.dataset.dir) === state.sort.dir);
  });
}

function setSort(by, dir) {
  if (by && SORTS.includes(by)) state.sort.by = by;
  if (dir) state.sort.dir = Number(dir) === -1 ? -1 : 1;
  localStorage.setItem(SORT_KEY, JSON.stringify(state.sort));
  markSort();
  closeMenus();
  paint();
}

function attrsOf(f, isFolder) {
  return `data-kind="${isFolder ? "folder" : "file"}" data-id="${esc(f.id)}" data-name="${esc(f.name)}"`;
}

function headCell(key, label) {
  const on = state.sort.by === key;
  const arrow = on ? `<i class="sort-ind">${state.sort.dir === 1 ? "↑" : "↓"}</i>` : "";
  const cls = key === "name" ? "" : " f" + key;
  return `<span class="fcell${cls}${on ? " on" : ""}"><button data-sort="${key}" type="button">${label}${arrow}</button></span>`;
}

function rowHtml(f, isFolder) {
  const cat = isFolder ? folderCat(f.name) : null;
  const op = isFolder
    ? ""
    : `<a class="fop-dl" href="/api/raw/${encodeURIComponent(f.id)}" target="_blank" rel="noopener">下载</a>`;
  return `<div class="frow" ${attrsOf(f, isFolder)}>
    <span class="fname"><span class="fic">${isFolder ? cat.ic : iconFor(f.name)}</span><span class="ftxt">${esc(
    f.name
  )}</span></span>
    <span class="ftime">${fmtDate(f.updated)}</span>
    <span class="fsize">${isFolder ? "—" : fmtSize(f.size)}</span>
    <span class="fop">${op}</span>
  </div>`;
}

function renderDetail(folders, files) {
  const head =
    headCell("name", "名称") + headCell("time", "修改时间") + headCell("size", "大小") + `<span class="fop">操作</span>`;
  return `<div class="flist">
    <div class="fhead">${head}</div>
    ${folders.map((f) => rowHtml(f, true)).join("")}
    ${files.map((f) => rowHtml(f, false)).join("")}
  </div>`;
}

function renderGrid(folders, files) {
  const card = (f, isFolder) => {
    const cat = isFolder ? folderCat(f.name) : null;
    return `<div class="gcard" data-cat="${isFolder ? cat.key : "file"}" ${attrsOf(f, isFolder)} title="${esc(f.name)}">
    <span class="thumb">${isFolder ? cat.ic : iconFor(f.name)}</span>
    <div class="nm">${esc(f.name)}</div>
    <div class="meta">${isFolder ? "文件夹" : fmtSize(f.size)}</div>
  </div>`;
  };
  return `<div class="grid">${folders.map((f) => card(f, true)).join("")}${files
    .map((f) => card(f, false))
    .join("")}</div>`;
}

function renderBody(folders, files) {
  if (!folders.length && !files.length) {
    const filtered = !!state.query.trim();
    return `<div class="empty"><span>${filtered ? "🔍" : "🌷"}</span><p>${
      filtered ? "本目录没有匹配项，回车可搜索全盘" : "这个目录还是空的"
    }</p></div>`;
  }
  if (state.view === "grid") return renderGrid(folders, files);
  return renderDetail(folders, files);
}

function renderResults(data) {
  const items = data.items || [];
  if (!items.length) {
    return `<div class="empty"><span>🔍</span><p>全盘没有找到「${esc(data.q || "")}」</p></div>`;
  }
  const rows = items
    .map((it) => {
      const isFolder = it.kind === "folder";
      const ic = isFolder ? folderCat(it.name).ic : iconFor(it.name);
      return `<div class="frow srow" ${attrsOf(it, isFolder)}>
        <span class="fname"><span class="fic">${ic}</span><span class="ftxt">${esc(it.name)}</span>${
          it.path ? `<span class="spath">${esc(it.path)}</span>` : ""
        }</span>
        <span class="ftime">${isFolder ? "—" : fmtDate(it.updated)}</span>
        <span class="fsize">${isFolder ? "—" : fmtSize(it.size)}</span>
        <span class="fop">${
          isFolder ? "" : `<a class="fop-dl" href="/api/raw/${encodeURIComponent(it.id)}" target="_blank" rel="noopener">下载</a>`
        }</span>
      </div>`;
    })
    .join("");
  return `<div class="srhead"><span>全盘搜索「${esc(data.q)}」· ${items.length} 个结果${
    data.truncated ? "（已扫描 " + data.scanned + " 个目录，结果可能不全）" : ""
  }</span><button type="button" id="btn-clear-search">返回目录</button></div>
  <div class="flist sflist">
    <div class="fhead"><span>名称 / 路径</span><span class="ftime">修改时间</span><span class="fsize">大小</span><span class="fop">操作</span></div>
    ${rows}
  </div>`;
}

function revealRows(listing) {
  requestAnimationFrame(() => {
    $$(".gcard, .frow", listing).forEach((el, i) => {
      el.style.transitionDelay = Math.min(i * 16, 280) + "ms";
      el.classList.add("in");
    });
  });
}

function paint() {
  const listing = $("#listing");
  if (state.results) {
    listing.innerHTML = renderResults(state.results);
    const clear = $("#btn-clear-search");
    if (clear) clear.onclick = clearSearch;
  } else {
    const q = state.query.trim().toLowerCase();
    const folders = q ? state.folders.filter((f) => f.name.toLowerCase().includes(q)) : state.folders;
    const files = q ? state.files.filter((f) => f.name.toLowerCase().includes(q)) : state.files;
    const sorted = sortLists(folders, files);
    listing.innerHTML = renderBody(sorted.folders, sorted.files);
  }
  listing.hidden = false;
  revealRows(listing);
}

function renderLock(wrong) {
  const name = state.path.length ? state.path[state.path.length - 1].name : "此目录";
  $("#listing").hidden = false;
  $("#listing").innerHTML = `<div class="lockcard">
    <div class="lockic">🔒</div>
    <h2>${esc(name)} 已加密</h2>
    <p>请输入访问口令</p>
    <form class="lockform" id="lock-form">
      <input id="lock-input" type="password" autocomplete="current-password" placeholder="访问口令" />
      <button type="submit">解锁</button>
    </form>
    <div class="lockerr" id="lock-err" ${wrong ? "" : "hidden"}>口令不正确，请重试</div>
  </div>`;
  $("#lock-form").onsubmit = async (e) => {
    e.preventDefault();
    const val = $("#lock-input").value.trim();
    if (!val) return;
    sessionStorage.setItem("sakura-pass:" + state.lockedDir, val);
    $("#lock-err").hidden = true;
    await loadDir(state.lockedDir);
  };
  $("#lock-input").focus();
}

function renderFileHead(d) {
  $("#dir-title").textContent = d.name || "文件详情";
  const bits = [fmtSize(d.size), (d.ext || "").toUpperCase() || "文件"];
  if (d.updated) bits.push(fmtDate(d.updated));
  $("#dir-sub").textContent = bits.join(" · ");
  $("#badge-cache").hidden = true;
  $("#about").hidden = true;
  document.title = (d.name || "文件") + " · " + SITE_TITLE;
}

function renderFilePage(d) {
  const url = location.origin + "/api/raw/" + encodeURIComponent(d.id);
  const img = isImg(d.name);
  const row = (k, v, mono) => `<div class="fmeta-row"><span>${k}</span><b${mono ? ' class="mono"' : ""}>${v}</b></div>`;
  const listing = $("#listing");
  listing.innerHTML = `<div class="fpage">
    <div class="fpage-ic">${iconFor(d.name)}</div>
    <h2 class="fpage-name">${esc(d.name)}</h2>
    <div class="fmeta">
      ${row("类型", esc((d.ext || "").toUpperCase() || "未知"))}
      ${row("大小", fmtSize(d.size))}
      ${row("修改时间", d.updated ? fmtDate(d.updated) : "—")}
      ${row("文件 ID", esc(d.id), true)}
    </div>
    <div class="fpage-ops">
      <a class="fbtn" href="${url}" target="_blank" rel="noopener" download>下载文件</a>
      <a class="fbtn ghost" href="${url}" target="_blank" rel="noopener">新窗口打开</a>
      <button class="fbtn ghost" id="btn-back">返回上级</button>
    </div>
    <div class="fapi">
      <div class="fapi-label">API 地址${img ? " · 可直接用于 &lt;img&gt; 引用" : " · 可直接外链引用"}</div>
      <div class="fapi-row"><input id="api-url" readonly value="${esc(url)}" spellcheck="false" /><button id="btn-copy">复制</button></div>
    </div>
  </div>`;
  listing.hidden = false;
  $("#about").hidden = true;
  $("#btn-back").onclick = () => writePath(state.path);
  $("#btn-copy").onclick = async (e) => {
    const input = $("#api-url");
    const btn = e.currentTarget;
    try {
      await navigator.clipboard.writeText(input.value);
    } catch (err) {
      input.select();
      document.execCommand("copy");
    }
    btn.textContent = "已复制";
    setTimeout(() => (btn.textContent = "复制"), 1400);
  };
}

function paintMeta() {
  const m = state.meta;
  if (!m) return;
  const ka = m.keepalive;
  const dot = $("#kv-dot");
  const text = $("#kv-status");
  if (ka && ka.ok) {
    dot.className = "on";
    text.textContent = `Cookie 正常 · 最近检查 ${ago(ka.ts)}`;
  } else if (ka && !ka.ok) {
    dot.className = "bad";
    text.textContent = `Cookie 异常（${ka.reason || ka.status || "失效"}）· 需更新 KV 的 COOKIE`;
  } else {
    dot.className = "";
    text.textContent = "Cookie 状态未知 · 等待定时检查";
  }
}

async function loadDir(id, force) {
  const pass = sessionStorage.getItem("sakura-pass:" + id) || "";
  const q = new URLSearchParams();
  if (pass) q.set("pass", pass);
  if (force) q.set("refresh", "1");
  const data = await api(`dir/${encodeURIComponent(id)}${q.toString() ? "?" + q.toString() : ""}`);
  if (data.locked) {
    state.lockedDir = id;
    state.folders = [];
    state.files = [];
    $("#pathbar").hidden = false;
    renderCrumb();
    renderHead({ folders: 0, files: 0 }, data.cached);
    $("#dir-sub").textContent = "加密目录";
    renderLock(!!pass);
    return;
  }
  state.lockedDir = null;
  state.folders = data.folders || [];
  state.files = data.files || [];
  paint();
  renderHead({ folders: state.folders.length, files: state.files.length }, data.cached);
}

async function load(force) {
  const id = state.path.length ? state.path[state.path.length - 1].id : "root";
  setBusy(true);
  $("#error").hidden = true;
  $("#pathbar").hidden = false;
  renderCrumb();
  try {
    await loadDir(id, force);
  } catch (e) {
    renderError(e);
  } finally {
    state.first = false;
    setBusy(false);
    hideLoader();
  }
}

async function loadFile() {
  setBusy(true);
  $("#error").hidden = true;
  $("#pathbar").hidden = false;
  renderCrumb();
  try {
    const d = await api("file/" + encodeURIComponent(state.file.id));
    if (d.name) state.file.name = d.name;
    renderFilePage(d);
    renderFileHead(d);
  } catch (e) {
    renderError(e);
  } finally {
    state.first = false;
    setBusy(false);
    hideLoader();
  }
}

function hideLoader() {
  const l = $("#loader");
  if (l && !l.classList.contains("off")) {
    l.classList.add("off");
    setTimeout(() => {
      l.style.display = "none";
    }, 700);
  }
}

let searchTimer = null;

function clearSearch() {
  state.query = "";
  state.results = null;
  $("#search-input").value = "";
  $("#search-hint").textContent = "当前目录过滤 · 回车搜索全盘";
  $("#dir-sub").textContent = `${state.folders.length} 个文件夹 · ${state.files.length} 个文件`;
  paint();
}

function syncSearchHint() {
  const q = state.query.trim();
  const hint = $("#search-hint");
  if (!q) {
    hint.textContent = "当前目录过滤 · 回车搜索全盘";
    return;
  }
  if (state.results) {
    hint.textContent = `全盘结果 ${state.results.items.length} 个`;
    return;
  }
  const n =
    state.folders.filter((f) => f.name.toLowerCase().includes(q.toLowerCase())).length +
    state.files.filter((f) => f.name.toLowerCase().includes(q.toLowerCase())).length;
  hint.textContent = `本目录 ${n} 项匹配 · 回车搜索全盘`;
}

function onSearchInput() {
  state.query = $("#search-input").value;
  state.results = null;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    paint();
    syncSearchHint();
  }, 120);
}

async function runGlobalSearch() {
  const q = state.query.trim();
  if (!q) return clearSearch();
  $("#search-hint").textContent = "正在全盘搜索…";
  $("#listing").classList.add("dim");
  try {
    const d = await api("search?q=" + encodeURIComponent(q));
    state.results = d;
    paint();
    syncSearchHint();
    $("#dir-sub").textContent = `全盘搜索「${q}」· ${(d.items || []).length} 个结果`;
  } catch (e) {
    renderError(e);
  } finally {
    $("#listing").classList.remove("dim");
  }
}

function toggleSearch(force) {
  const bar = $("#searchbar");
  const open = force === undefined ? bar.hidden : force;
  bar.hidden = !open;
  $("#btn-search").classList.toggle("on", open);
  if (open) $("#search-input").focus();
  else clearSearch();
}

function closeMenus() {
  $("#sort-menu").hidden = true;
}

const themeNow = () => document.documentElement.dataset.theme || "light";

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem(THEME_KEY, t);
  $("#btn-theme").textContent = t === "dark" ? "☀️" : "🌙";
}

function markView() {
  $$("#view-switch button").forEach((b) => {
    const on = b.dataset.view === state.view;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
}

function setView(v) {
  if (!VIEWS.includes(v)) return;
  state.view = v;
  localStorage.setItem(VIEW_KEY, v);
  markView();
  paint();
}

function route() {
  const r = parseHash();
  state.path = r.path;
  state.file = r.file;
  state.query = "";
  state.results = null;
  closeMenus();
  if ($("#search-input")) $("#search-input").value = "";
  if ($("#searchbar")) $("#searchbar").hidden = true;
  if ($("#btn-search")) $("#btn-search").classList.remove("on");
  $("#pathbar").hidden = false;
  $("#listing").hidden = true;
  if (state.file) return loadFile();
  return load();
}

function initPetals() {
  const c = document.getElementById("petal-canvas");
  if (!c || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const ctx = c.getContext("2d");
  const colors = ["#ffb8d6", "#ffd0e4", "#ffe0ee", "#e6c9ff"];
  const petals = [];
  let W = 0;
  let H = 0;
  const resize = () => {
    W = c.width = innerWidth;
    H = c.height = innerHeight;
  };
  resize();
  addEventListener("resize", resize, { passive: true });
  for (let i = 0; i < 12; i++) {
    petals.push({
      x: Math.random() * W,
      y: Math.random() * H,
      r: 4 + Math.random() * 5,
      vy: 0.3 + Math.random() * 0.7,
      sw: Math.random() * Math.PI * 2,
      a: 0.3 + Math.random() * 0.3,
      col: colors[(Math.random() * colors.length) | 0],
    });
  }
  const draw = () => {
    ctx.clearRect(0, 0, W, H);
    for (const p of petals) {
      p.y += p.vy;
      p.sw += 0.01;
      p.x += Math.sin(p.sw) * 0.7;
      if (p.y > H + 20) {
        p.y = -20;
        p.x = Math.random() * W;
      }
      ctx.globalAlpha = p.a;
      ctx.fillStyle = p.col;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, p.r, p.r * 0.68, p.sw, 0, Math.PI * 2);
      ctx.fill();
    }
    requestAnimationFrame(draw);
  };
  draw();
}

function init() {
  setTheme(themeNow());
  markView();
  markSort();

  $$("#view-switch button").forEach((b) => {
    b.onclick = () => setView(b.dataset.view);
  });
  $("#btn-theme").onclick = () => setTheme(themeNow() === "dark" ? "light" : "dark");
  $("#btn-refresh").onclick = () => load(true);
  $("#btn-retry").onclick = () => route();
  $("#btn-search").onclick = () => toggleSearch();
  $("#btn-search-close").onclick = () => toggleSearch(false);
  $("#search-input").oninput = onSearchInput;
  $("#search-input").onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runGlobalSearch();
    }
    if (e.key === "Escape") toggleSearch(false);
  };
  $("#btn-sort").onclick = (e) => {
    e.stopPropagation();
    const m = $("#sort-menu");
    m.hidden = !m.hidden;
  };
  $("#sort-menu").onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    setSort(b.dataset.by, b.dataset.dir);
  };
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#sort-menu") && !e.target.closest("#btn-sort")) closeMenus();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenus();
    if (
      e.key === "/" &&
      !state.file &&
      !/input|textarea|select/i.test(document.activeElement.tagName)
    ) {
      e.preventDefault();
      toggleSearch(true);
    }
  });

  $("#listing").addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    if (e.target.closest("button")) return;
    const el = e.target.closest("[data-kind]");
    if (!el) return;
    if (el.dataset.kind === "folder") {
      const target = { id: el.dataset.id, name: el.dataset.name };
      writePath(el.closest(".srow") ? [target] : state.path.concat([target]));
    } else {
      writeFile(el.dataset.id, el.dataset.name);
    }
  });

  $("#listing").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sort]");
    if (!b) return;
    const key = b.dataset.sort;
    setSort(key, state.sort.by === key ? -state.sort.dir : key === "name" ? 1 : -1);
  });

  addEventListener("hashchange", route);

  renderHead(null, null);
  initPetals();
  route();

  api("meta")
    .then((m) => {
      state.meta = m;
      paintMeta();
    })
    .catch(() => {});
}

init();
