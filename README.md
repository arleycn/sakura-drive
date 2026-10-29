# Sakura Drive

把 **Teambition 项目文件**变成自己的在线云盘 —— 基于 Cloudflare Worker + KV + Static Assets，纯 JS 零框架、无构建步骤、只读不改源数据。

```
浏览器 ⇄ Cloudflare Worker ⇄ Teambition 私有 API
              ⇅
        KV（会话 Cookie / 目录缓存 / 口令）
```

> 不是官方产品，用的是 Teambition 的私有接口。想部署自己的，直接看 **[DEPLOY.md](./DEPLOY.md)**（15 分钟，全程免费额度）。

## 特性

- **浏览**：详细视图 / 网格视图（记忆选择）、面包屑、文件详情页、日夜主题、移动端适配
- **排序**：名称 / 修改时间 / 大小，升降序，表头与工具栏双入口，记忆选择
- **搜索**：当前目录即时过滤（输入即筛）+ 回车全盘递归搜索（限目录数 / 时间预算，结果缓存 5 分钟）
- **目录密码**：目录里放一个 `.password` 文件，内容即口令；未解锁服务端**不下发任何文件名**
- **下载**：Worker 边缘流式代理 + Range 支持，绕过跨域和签名直链过期
- **缓存与保活**：目录缓存 90 秒（页脚显示「实时 / 缓存」）、Cron 每 30 分钟检测 Cookie 状态
- **零依赖前端**：原生 HTML/CSS/JS，全部资源约 59 KB（gzip 后 17 KB），首屏无框架开销

## 快速开始

```bash
git clone https://github.com/arleycn/sakura-drive.git
cd sakura-drive && npm install
npx wrangler login
npx wrangler kv namespace create TB_KV          # 把返回的 id 填进 wrangler.toml
npx wrangler kv key put COOKIE "TEAMBITION_SESSIONID=...; TEAMBITION_SESSIONID.sig=...;" --binding TB_KV --remote
npx wrangler kv key put PROJECT_ID "<你的项目ID>" --binding TB_KV --remote
npx wrangler deploy
```

三个值的来源、逐步截图级说明、Git 自动部署参数、排错表 → **[DEPLOY.md](./DEPLOY.md)**

> `wrangler.toml` 里 KV id 是占位符 `<替换为 ...>`，不替换部署会报绑定错误；`name` 决定你的 `*.workers.dev` 子域，改成自己喜欢的。
> 换成自己的标题 / 域名 / 配色见 DEPLOY.md 第 7 节。

## 目录结构

```
sakura-drive/
├── src/index.js        Worker 主程序：/api/* + 静态托管 + Cron 保活
├── public/             前端（无构建）
│   ├── index.html
│   ├── app.js          路由 / 渲染 / 排序 / 搜索 / 口令
│   ├── style.css       樱色主题（CSS 变量，日夜双色）
│   ├── 404.html        404 页（not_found_handling = "404-page"）
│   ├── _headers        安全响应头 + 缓存策略
│   └── robots.txt
├── wrangler.toml       Worker 配置 + KV 绑定 + Cron 触发
├── DEPLOY.md           搭建文档
└── package.json        仅含 wrangler 依赖
```

## 接口

| 路由 | 说明 |
|---|---|
| `GET /api/meta` | 项目信息（含根目录 ID）+ Cookie 保活状态 |
| `GET /api/dir/:id[?refresh=1&pass=]` | 列目录；`root` 取项目根；目录含 `.password` 且口令不对时返回 `{locked:true}` |
| `GET /api/search?q=&[id=]` | 递归搜索，默认全盘，最多 60 个目录 / 7 秒 |
| `GET /api/file/:id` | 文件详情（名称 / 大小 / 类型 / 扩展名 / 修改时间） |
| `GET /api/raw/:id` | 下载 / 预览流，支持 Range |
| `GET /api/keepalive[?run=1]` | 查看 / 立即执行 Cookie 保活 |

KV 键：`COOKIE` · `PROJECT_ID` · `KEEPALIVE`(7d) · `project:<pid>`(1d) · `dircache:<pid>:<dirId>`(90s) · `dirpass:<workId>`(900s) · `search:<pid>:all:<q>`(300s，指定目录时为 `search:<pid>:<dirId>:<q>`)

## 目录密码约定

在 Teambition 对应目录上传名为 `.password` 的文本文件，内容即口令（首尾空白去除，上限 64 字符）。
未解锁只返回 `{locked:true}`；`.password` 不出现在列表里；含密码的目录不参与全盘搜索。

## 已知限制

- Teambition 已并入钉钉，**私有 API 可能随时调整、Cookie 可能失效**；失效时页面会提示，重新提取 Cookie 覆盖写 KV 即可。
- 会话 Cookie 是账号级凭据，本项目**没有多用户/多租户概念**，一个部署对应一个账号。
- 默认无访问控制（知道 URL 即可访问），需要门槛请用 `.password` 或自行在入口加鉴权。
- 跨境回源 `file.teambition.com` 的速度取决于线路；要加速可自行接 R2 做热点缓存（本项目未启用）。
- 全盘搜索是实时递归私有 API，目录极多时较慢，已用目录数与时间预算兜底。
- 文件夹「修改时间」恒为 `—`：Teambition 的目录对象本身不带 `updatedAt`，非 bug。

## 致谢

- 私有接口路径参考 [FlxSNX/TeambitionShare](https://github.com/FlxSNX/TeambitionShare)
- 版式参考 [spencerwooo/onedrive-vercel-index](https://github.com/spencerwooo/onedrive-vercel-index)

## 许可

[MIT](./LICENSE)
