const TB_API = "https://www.teambition.com/api";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

const DIR_CACHE_TTL = 90;
const PROJECT_TTL = 86400;
const KEEPALIVE_TTL = 7 * 86400;
const PASS_CACHE_TTL = 900;
const SEARCH_CACHE_TTL = 300;
const SEARCH_MAX_DIRS = 60;
const SEARCH_BUDGET_MS = 7000;

const LOCK_FILE = ".password";

function tbHeaders(cookie) {
  return {
    Cookie: cookie,
    "User-Agent": UA,
    Accept: "application/json",
    Referer: "https://www.teambition.com/",
  };
}

function fileHeaders(range) {
  const h = { "User-Agent": UA, Referer: "https://www.teambition.com/" };
  if (range) h.Range = range;
  return h;
}

async function kvGet(env, key) {
  try {
    return await env.TB_KV.get(key);
  } catch {
    return null;
  }
}

async function kvPut(env, key, val, ttl) {
  try {
    await env.TB_KV.put(key, val, ttl ? { expirationTtl: ttl } : undefined);
  } catch {}
}

async function kvDel(env, key) {
  try {
    await env.TB_KV.delete(key);
  } catch {}
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function nameOf(file) {
  return String(file.fileName || file.title || "");
}

function extOf(name) {
  return (name.includes(".") ? name.split(".").pop() : "").toLowerCase();
}

async function getProject(env, cookie, projectId) {
  const cacheKey = "project:" + projectId;
  const cached = await kvGet(env, cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch {}
  }
  const res = await fetch(`${TB_API}/projects/${projectId}`, { headers: tbHeaders(cookie) });
  if (!res.ok) throw new Error("Teambition 项目接口 " + res.status);
  const d = await res.json();
  const info = {
    id: d._id || projectId,
    name: d.name || "",
    rootId: d._rootCollectionId || "",
    updated: d.updated || null,
  };
  if (info.rootId) await kvPut(env, cacheKey, JSON.stringify(info), PROJECT_TTL);
  return info;
}

async function listDirRaw(env, cookie, projectId, parentId) {
  const base = `_parentId=${encodeURIComponent(parentId)}&_projectId=${encodeURIComponent(
    projectId
  )}&order=updatedDesc&count=1000&page=1`;
  const [colRes, workRes] = await Promise.all([
    fetch(`${TB_API}/collections?${base}`, { headers: tbHeaders(cookie) }),
    fetch(`${TB_API}/works?${base}`, { headers: tbHeaders(cookie) }),
  ]);
  if (!colRes.ok && !workRes.ok) {
    throw new Error(
      "Teambition API " + colRes.status + "（Cookie 可能已失效，请更新 KV 的 COOKIE）"
    );
  }
  const folders = colRes.ok ? await colRes.json() : [];
  const files = workRes.ok ? await workRes.json() : [];
  return { folders: Array.isArray(folders) ? folders : [], files: Array.isArray(files) ? files : [] };
}

function visible(name) {
  return !!name && !String(name).startsWith(".");
}

// 列表屏蔽 .md：这类目录通常拿它当说明文档，混在文件列表里干扰浏览
function listed(name) {
  return visible(name) && !/\.md$/i.test(String(name));
}

function normalizeFolder(d) {
  return { id: d._id, name: d.title, updated: d.updated || d.created || null };
}

function normalizeFile(f) {
  const name = nameOf(f);
  return {
    id: f._id,
    name,
    size: f.fileSize || 0,
    type: f.fileType || "",
    ext: (f.ext || extOf(name)).toLowerCase(),
    updated: f.updated || f.lastVersionTime || f.created || null,
  };
}

async function getWork(env, cookie, id) {
  const res = await fetch(`${TB_API}/works/${id}`, { headers: tbHeaders(cookie) });
  if (!res.ok) return { status: res.status, data: null };
  return { status: 200, data: await res.json() };
}

async function getDir(env, cookie, projectId, id, refresh) {
  const cacheKey = `dircache:${projectId}:${id}`;
  if (!refresh) {
    const cached = await kvGet(env, cacheKey);
    if (cached) {
      try {
        return { data: JSON.parse(cached), cached: true };
      } catch {}
    }
  }
  const { folders, files } = await listDirRaw(env, cookie, projectId, id);
  const lock = files.find((f) => nameOf(f).toLowerCase() === LOCK_FILE);
  const data = {
    id,
    folders: folders.map(normalizeFolder).filter((x) => visible(x.name)),
    files: files.map(normalizeFile).filter((x) => listed(x.name)),
    lockId: lock ? lock._id : null,
    ts: Date.now(),
  };
  await kvPut(env, cacheKey, JSON.stringify(data), DIR_CACHE_TTL);
  return { data, cached: false };
}

async function dirPassword(env, cookie, workId) {
  const cacheKey = "dirpass:" + workId;
  const cached = await kvGet(env, cacheKey);
  // KV 里用 "-" 表示「已确认未上锁」，与「从未读过」区分开，否则空口令目录会每次都回源
  if (cached) return cached === "-" ? "" : cached;
  const { data } = await getWork(env, cookie, workId);
  if (!data) return "";
  const src = data.downloadUrl || data.previewUrl;
  let pass = "";
  if (src) {
    try {
      const res = await fetch(src, { headers: fileHeaders() });
      if (res.ok) pass = (await res.text()).trim().slice(0, 64);
    } catch {}
  }
  await kvPut(env, cacheKey, pass || "-", PASS_CACHE_TTL);
  return pass;
}

async function unlockDir(env, cookie, data, pass) {
  if (!data.lockId) return { ok: true };
  const expected = await dirPassword(env, cookie, data.lockId);
  if (!expected) return { ok: true };
  return { ok: String(pass || "") === expected };
}

async function searchTree(env, cookie, projectId, rootId, q, isRoot) {
  const cachedKey = (!isRoot ? `search:${projectId}:${rootId}:` : `search:${projectId}:all:`) + q.toLowerCase();
  const hit = await kvGet(env, cachedKey);
  if (hit) {
    try {
      return { ...JSON.parse(hit), cached: true };
    } catch {}
  }

  const needle = q.toLowerCase();
  const started = Date.now();
  const queue = [{ id: rootId, path: "" }];
  const seen = new Set();
  const items = [];
  let truncated = false;

  while (queue.length) {
    if (seen.size >= SEARCH_MAX_DIRS || Date.now() - started > SEARCH_BUDGET_MS) {
      truncated = true;
      break;
    }
    const batch = queue.splice(0, 4);
    const lists = await Promise.all(
      batch.map(async (node) => {
        if (seen.has(node.id)) return null;
        seen.add(node.id);
        try {
          return { node, ...(await listDirRaw(env, cookie, projectId, node.id)) };
        } catch {
          return null;
        }
      })
    );
    for (const res of lists) {
      if (!res) continue;
      const locked = res.files.some((f) => nameOf(f).toLowerCase() === LOCK_FILE);
      if (locked) continue;
      for (const f of res.folders) {
        const name = nameOf(f);
        if (!visible(name)) continue;
        const path = res.node.path ? res.node.path + " / " + name : name;
        if (name.toLowerCase().includes(needle)) {
          items.push({ id: f._id, name, kind: "folder", path: res.node.path });
        }
        if (queue.length + seen.size < SEARCH_MAX_DIRS) queue.push({ id: f._id, path });
      }
      for (const f of res.files) {
        const n = normalizeFile(f);
        if (!listed(n.name)) continue;
        if (n.name.toLowerCase().includes(needle)) {
          items.push({ ...n, kind: "file", path: res.node.path });
        }
      }
    }
  }

  const out = {
    items: items.slice(0, 200),
    scanned: seen.size,
    truncated,
    q,
  };
  await kvPut(env, cachedKey, JSON.stringify(out), SEARCH_CACHE_TTL);
  return { ...out, cached: false };
}

async function proxyBinary(url, request, extraHeaders) {
  const dl = await fetch(url, { headers: fileHeaders(request.headers.get("range")) });
  if (!dl.ok && dl.status !== 206) {
    return json({ error: "download_failed", status: dl.status }, dl.status);
  }
  const headers = new Headers(extraHeaders || {});
  for (const k of ["content-type", "content-length", "content-range", "accept-ranges", "etag"]) {
    const v = dl.headers.get(k);
    if (v) headers.set(k, v);
  }
  return new Response(dl.body, { status: dl.status, headers });
}

function disposition(name) {
  const fallback = String(name || "file").replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name || "file")}`;
}

async function keepAlive(env) {
  const cookie = await kvGet(env, "COOKIE");
  const projectId = await kvGet(env, "PROJECT_ID");
  const ts = Date.now();
  if (!cookie || !projectId) {
    await kvPut(env, "KEEPALIVE", JSON.stringify({ ok: false, reason: "config_missing", ts }), KEEPALIVE_TTL);
    return { ok: false, reason: "config_missing", ts };
  }
  try {
    const res = await fetch(`${TB_API}/projects/${projectId}`, { headers: tbHeaders(cookie) });
    const status = { ok: res.ok, status: res.status, ts };
    await kvPut(env, "KEEPALIVE", JSON.stringify(status), KEEPALIVE_TTL);
    if (!res.ok) await kvDel(env, "project:" + projectId);
    return status;
  } catch (e) {
    const status = { ok: false, reason: String(e && e.message ? e.message : e), ts };
    await kvPut(env, "KEEPALIVE", JSON.stringify(status), KEEPALIVE_TTL);
    return status;
  }
}

async function handleApi(request, env, parts) {
  const url = new URL(request.url);
  const action = parts[1];

  if (action === "keepalive") {
    let last = await kvGet(env, "KEEPALIVE");
    if (url.searchParams.get("run") === "1" || !last) {
      last = JSON.stringify(await keepAlive(env));
    }
    let status = null;
    try {
      status = last ? JSON.parse(last) : null;
    } catch {}
    return json({ status });
  }

  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  const cookie = await kvGet(env, "COOKIE");
  const projectId = await kvGet(env, "PROJECT_ID");
  if (!cookie || !projectId) {
    return json({ error: "config_missing", message: "KV 未配置 COOKIE 或 PROJECT_ID" }, 500);
  }

  try {
    if (action === "meta") {
      const project = await getProject(env, cookie, projectId);
      const raw = await kvGet(env, "KEEPALIVE");
      let keepalive = null;
      try {
        keepalive = raw ? JSON.parse(raw) : null;
      } catch {}
      return json({ project, keepalive, now: Date.now() });
    }

    if (action === "dir") {
      const project = await getProject(env, cookie, projectId);
      let id = decodeURIComponent(parts[2] || "root");
      if (id === "root" || id === "ROOT") id = project.rootId;
      if (!id) return json({ error: "no_root" }, 500);
      const refresh = url.searchParams.get("refresh") === "1";
      const { data, cached } = await getDir(env, cookie, projectId, id, refresh);
      const unlocked = await unlockDir(env, cookie, data, url.searchParams.get("pass"));
      // 未解锁只回 locked，一个文件名都不下发
      if (!unlocked.ok) return json({ id: data.id, locked: true, cached });
      return json({
        id: data.id,
        folders: data.folders,
        files: data.files,
        ts: data.ts,
        cached,
      });
    }

    if (action === "search") {
      const q = String(url.searchParams.get("q") || "").trim().slice(0, 64);
      if (q.length < 1) return json({ items: [], q });
      const project = await getProject(env, cookie, projectId);
      let rootId = project.rootId;
      let isRoot = true;
      const scoped = url.searchParams.get("id");
      if (scoped) {
        rootId = decodeURIComponent(scoped);
        isRoot = false;
      }
      const out = await searchTree(env, cookie, projectId, rootId, q, isRoot);
      return json(out);
    }

    if (action === "file") {
      const { status, data: d } = await getWork(env, cookie, decodeURIComponent(parts[2]));
      if (!d) return json({ error: "fetch_failed", status }, status);
      const name = nameOf(d);
      return json({
        id: d._id,
        name,
        size: d.fileSize,
        type: d.fileType,
        ext: (d.ext || extOf(name)).toLowerCase(),
        updated: d.updated || d.lastVersionTime || d.created || null,
      });
    }

    if (action === "raw") {
      const { data: d } = await getWork(env, cookie, decodeURIComponent(parts[2]));
      if (!d) return json({ error: "fetch_failed" }, 404);
      if (!d.downloadUrl) return json({ error: "no_download_url" }, 404);
      return proxyBinary(d.downloadUrl, request, {
        "content-disposition": disposition(nameOf(d)),
        "cache-control": "no-store",
      });
    }

    return json({ error: "unknown_action" }, 404);
  } catch (e) {
    return json({ error: "server_error", message: String(e && e.message ? e.message : e) }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "api") return handleApi(request, env, parts);
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(keepAlive(env));
  },
};
