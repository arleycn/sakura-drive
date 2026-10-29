# 搭建文档 · 从零部署自己的 Teambition 云盘

这份文档面向**第一次接触本项目**的人：不需要懂 Cloudflare Worker，照着做能跑起来。
全程免费额度够用（Worker 每天 10 万请求、KV 每天 10 万读）。

预计耗时：**15 分钟**（不含 Cloudflare 构建等待）。

---

## 0. 准备清单

| 需要 | 说明 |
|---|---|
| Cloudflare 账号 | 免费计划即可，注册 <https://dash.cloudflare.com/sign-up> |
| Teambition 账号 | 已登录，且有至少一个项目 |
| Node.js 18+ | 只在「本地部署」和「初始化 KV」时用；用 Dashboard 纯网页部署可跳过 |
| 一个能放文件的 Teambition 项目 | 文件放在项目的**「项目文件」**里，任务附件不在本项目的读取范围 |

---

## 1. 它是怎么工作的

```
你的浏览器
   │  GET /api/dir/root
   ▼
Cloudflare Worker  ──── 1. 从 KV 取 Cookie ──►  Cloudflare KV
   │                ◄── 2. 拿到会话 Cookie ────
   │
   │  3. 带着 Cookie 调私有 API
   ▼
www.teambition.com/api/collections · /api/works · /api/works/{id}
   │
   └─ 4. 拿到签名直链 downloadUrl → Worker 流式转发给浏览器（支持 Range）
```

要点：

- **源数据完全只读**，项目只调用查询类接口，不会修改/删除你的 Teambition 任何内容。
- Teambition 没有给个人开发者开放 OAuth，所以只能用**浏览器会话 Cookie** 鉴权，这是本项目的核心前提。
- 直链带 JWT 会过期（几分钟），因此 Worker 每次都实时取链，不做直链缓存；目录列表缓存 90 秒。
- 前端是纯静态页（无构建、无框架），由 Worker 的 Static Assets 托管。

---

## 2. 第一步：拿到两个值

你需要 `Cookie` 和 `PROJECT_ID`，后面都要写进 KV。

### 2.1 Teambition 会话 Cookie

1. 浏览器打开 <https://www.teambition.com> 并**登录**。
2. 随便点进一个项目的「文件」页面（确保能看到文件列表）。
3. 按 `F12` 打开开发者工具 → 切到 **Application（应用）** 面板 → 左侧 **Storage → Cookies → `https://www.teambition.com`**。
4. 在列表里找到这两条：

   | 名称 | 说明 |
   |---|---|
   | `TEAMBITION_SESSIONID` | 会话 ID |
   | `TEAMBITION_SESSIONID.sig` | 上面那个值的 HMAC 签名 |

   > Firefox 在「存储 → Cookie」；Safari 需先开启「开发」菜单。

5. 把两个 **Value** 按下面格式拼成一条字符串（**两个都要，缺一个不行**，`.sig` 是签名，改了 ID 不换签名会直接失效）：

   ```
   TEAMBITION_SESSIONID=粘贴第一段值; TEAMBITION_SESSIONID.sig=粘贴第二段值;
   ```

6. 立刻验证一下这条 Cookie 是否有效（本机有 curl 就行）：

   ```bash
   curl -s 'https://www.teambition.com/api/projects/<你的项目ID>' \
     -H 'Cookie: TEAMBITION_SESSIONID=...; TEAMBITION_SESSIONID.sig=...;' \
     -H 'Accept: application/json'
   ```

   返回一段项目 JSON（含 `"_id"`、`"_rootCollectionId"`）= 有效；
   返回 `{"name":"Unauthorized"...}` 或 401 = 没复制对（多半是漏了分号或复制到了过期值——Cookie 有多条同名项时取**最新那条**）。

> **Cookie 会过期。** 有效期通常几个月，浏览器里「退出登录」「改密码」「清理 Cookie」都会立即失效。
> 失效后本站会显示「Cookie 可能失效」，重新提取一次、覆盖写 KV 即可（见 3.2）。

### 2.2 项目 ID（PROJECT_ID）

打开你的 Teambition 项目，看地址栏：

```
https://www.teambition.com/project/0123456789abcdef01234567/...
                                    └─────────── 这就是 PROJECT_ID ───────────┘
```

24 位十六进制字符串。根目录 ID 不需要手动配，Worker 会自动请求 `/api/projects/{id}` 取 `_rootCollectionId`。

---

## 3. 第二步：部署 Worker

### 3.1 拉代码 + 建 KV + 绑定

```bash
git clone https://github.com/arleycn/sakura-drive.git
cd sakura-drive
npm install

# 登录 Cloudflare（会弹浏览器授权）
npx wrangler login

# 创建 KV 命名空间
npx wrangler kv namespace create TB_KV
```

命令会打印一段配置，形如：

```toml
[[kv_namespaces]]
binding = "TB_KV"
id = "0123456789abcdef0123456789abcdef"
```

把其中的 `id` 复制到 `wrangler.toml` 对应的位置（**必须替换**，否则 KV 绑定无效）：

```toml
[[kv_namespaces]]
binding = "TB_KV"
id = "0123456789abcdef0123456789abcdef"
```

同时把 `wrangler.toml` 顶部的 `name` 改成你想要的名字（它会成为 `https://<name>.<你的子域>.workers.dev`）。

### 3.2 写入 Cookie 和项目 ID

```bash
npx wrangler kv key put COOKIE "TEAMBITION_SESSIONID=...; TEAMBITION_SESSIONID.sig=...;" --binding TB_KV --remote
npx wrangler kv key put PROJECT_ID "你的24位项目ID" --binding TB_KV --remote
```

> ⚠️ **`--remote` 千万别漏**。漏了会写进本地模拟 KV，线上读不到，表现就是「命令成功但站点还是 401」。

### 3.3 部署

```bash
npx wrangler deploy
```

输出会给你线上地址，形如 `https://sakura-drive.<你的子域>.workers.dev`。
如果提示 `wrangler.toml` 里的 `compatibility_date` 过旧，改成当前日期即可。

---

## 4. 第三步：验收

按顺序打这几个地址（换成你自己的域名）：

| 检查项 | 期望结果 |
|---|---|
| `GET /` | 打开前端首页，不再卡在 loading |
| `GET /api/meta` | `{"project":{"name":"你的项目名","rootId":"..."},"keepalive":{...}}` |
| `GET /api/dir/root` | `{"folders":[...],"files":[...],"cached":false}`，文件夹数和 Teambition 里一致 |
| 刷新一次 `/api/dir/root` | `"cached":true`（90 秒缓存生效） |
| `GET /api/keepalive?run=1` | `{"ok":true,"status":200}`，说明 Cookie 可用 |
| 点任意文件下载 | 正常下载，大文件能拖进度条（Range 生效） |

全部通过就部署完成了。Cron 每 30 分钟会自动跑一次保活，把状态写进 KV，页脚会显示「Cookie 正常 · 最近检查 N 分钟前」。

---

## 5. 可选：改成 Git 推送自动部署

不想每次改代码都手动 `wrangler deploy`，就接 GitHub 自动构建。

**操作路径**：Cloudflare Dashboard → **Workers & Pages** → 选中你已有的 Worker（`sakura-drive`）→ **Settings → Builds → Connect**。

> ⚠️ 必须从**已有 Worker 的 Settings** 进，不要走 `Create application`，那会新建第二个 Worker，KV 绑定还得再配一遍。

参数照下面填：

| 字段 | 值 |
|---|---|
| Git 仓库 / 分支 | 你的仓库 / `main` |
| Root directory | **留空** |
| Build command | **留空**（纯 JS 无构建步骤） |
| Deploy command | 默认 `npx wrangler deploy` |
| Build variables / secrets | 不填 |
| Watch paths | `*`，排除 `node_modules/**,.git/` |
| **Preview builds** | **关闭**（否则每个非 main 分支都会建预览站，KV 会混用生产数据） |

四个实测踩坑：

1. **Dashboard 里的 Worker 名必须和 `wrangler.toml` 的 `name` 完全一致**，否则构建产物跑到另一个 Worker 上。
2. Builds 用的是**仓库里 `package.json` 的 wrangler 版本**。本项目已锁 `^4.x` 并提交了 `package-lock.json`，不要降级。
3. 首次构建实测 **6–7 分钟**，别以为失败了一直点重试。
4. 判断线上是否真的更新，`wrangler deployments status` 里 Git 构建的部署同样显示 `Source: Unknown`，**没法靠 Source 区分**。可靠办法：`curl` 抓线上 `app.js` 搜某个新特征字符串，或对比部署的 Created 时间。

---

## 6. 目录密码怎么用

想让某个目录需要口令才能进：

1. 在 Teambition 里给那个目录**上传一个名为 `.password` 的文本文件**；
2. 文件内容就是口令（首尾空白会被去掉，上限 64 字符），例如 `my-secret-2026`；
3. 无需改代码、无需重启。

行为说明：

- 未解锁时 `/api/dir/:id` 只返回 `{"locked":true}`，**一个文件名都不会下发**；
- 前端弹出口令卡片，解锁后口令存在 `sessionStorage`（关标签页即失效）；
- 服务端把 `.password` 内容缓存 15 分钟，改口令后最多等 15 分钟生效（或刷新 KV 里 `dirpass:<文件ID>`）；
- `.password` 本身不会出现在文件列表里；含密码的目录**不参与全盘搜索**，不会被搜索结果连带暴露。

---

## 7. 改成你自己的（个性化清单）

开源版是中性的模板站（标题 `Sakura Drive`，没有作者信息），部署后按下面换成自己的：

| 改什么 | 位置 |
|---|---|
| 站点标题（浏览器标签） | `public/app.js` 顶部 `SITE_TITLE`、`renderHead()` 里的默认标题；同时改 `public/index.html` 的 `<title>` 与 `h1#dir-title` |
| **canonical / OG 域名** | `public/index.html` 里 `canonical`、`og:url` 默认是 `https://example.com/`，**必须换成你自己的域名**，否则分享卡片和 SEO 都指向错的地方 |
| 首页介绍卡片 | `public/index.html` 里 `#about` 区块（标题、链接、说明文案） |
| 页脚 | `public/index.html` 底部 `.fcard`（标题、三个链接按钮、版权行） |
| 主题色 | `public/style.css` 顶部 `:root` 的 `--pink / --purple / --sky / --mint` 等变量，暗色在 `html[data-theme="dark"]` |
| 文件夹图标归类 | `public/app.js` 的 `FOLDER_CATS`（按名称正则匹配） |
| 目录缓存时长 | `src/index.js` `DIR_CACHE_TTL`（默认 90 秒） |
| 搜索范围上限 | `src/index.js` `SEARCH_MAX_DIRS`（60 个目录）、`SEARCH_BUDGET_MS`（7000 毫秒）、`SEARCH_CACHE_TTL`（300 秒） |
| 口令校验缓存 | `src/index.js` `PASS_CACHE_TTL`（900 秒） |
| 想显示 `.md` 文件 | `src/index.js` 的 `listed()` 里去掉 `.md` 过滤（默认在列表隐藏） |

改完 `npx wrangler deploy`（或 push 等自动构建）即可。

---

## 8. 排错

| 现象 | 原因 | 怎么修 |
|---|---|---|
| 首页能开，但一直报「Cookie 可能失效」 | Cookie 过期 / 拼错 / 漏了 `.sig` | 重新提取，覆盖写 KV `COOKIE` |
| `kv key put` 成功但线上仍 401 | 漏了 `--remote` | 加 `--remote` 重写 |
| `/api/dir/root` 返回 `{"locked":true}` | 根目录被放了 `.password` | 删掉根目录的 `.password` |
| 目录是空的，但 Teambition 里明明有文件 | ① 文件在任务附件而非「项目文件」② 文件名以 `.` 开头被过滤 ③ 是 `.md`（默认隐藏） | 移到项目文件 / 改名 |
| 部署后访问 404 | `wrangler.toml` 的 `[assets] directory` 不对，或 KV 绑定 id 没换 | 核对 `wrangler.toml` |
| 大文件下载很慢 / 断流 | 跨境回源 `file.teambition.com`，取决于线路 | 属网络问题；可自行加 R2 做热点缓存 |
| push 了但线上没更新 | 构建排队（6–7 分钟）、Build command 填了东西、Worker 名不一致、Preview builds 开着 | 见第 5 节四个坑 |
| 搜索很慢或结果不全 | 全盘搜索是实时递归私有 API，受 `SEARCH_MAX_DIRS` / 时间预算限制 | 调大上限（会更慢），或进目录用「当前目录过滤」 |
| 文件夹「修改时间」永远是 `—` | Teambition 的目录对象本身不带 `updatedAt` | 不是 bug，源数据就这样 |

---

## 9. 安全与免责

- **Cookie 等于你 Teambition 账号的登录态**，拿到它就能读你账号下的内容。请只写进自己的 KV，**不要提交到 git、不要发到聊天里、不要外借**。泄露了就去 Teambition 退出所有设备、重新登录，旧 Cookie 立即失效。
- 本项目调用的是**非公开接口**，Teambition（已并入钉钉）随时可能调整或封禁；届时只能等适配或换方案。
- 默认**没有访问控制**：知道 URL 的人都能浏览和下载。要为私人数据加门槛，用第 6 节的 `.password`（按目录加锁），或自己在 Worker 入口加一层鉴权（例如校验 `Authorization` 头）。
- 请只挂载**你自己拥有或有权使用**的文件。公开分享他人版权内容的风险由部署者自负。
- 全部代码以 MIT 许可发布，按「现状」提供，不保证可用性与数据安全。

---

有问题欢迎到仓库提 issue：<https://github.com/arleycn/sakura-drive/issues>
