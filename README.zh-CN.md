<p align="center">
  <img src="https://raw.githubusercontent.com/yuyuanjingxuan/dsh-header-fix/main/logo.svg" width="96" height="96" alt="">
</p>

# dsh-header-fix

[English](README.md) | 简体中文

[![npm](https://img.shields.io/npm/v/dsh-header-fix)](https://www.npmjs.com/package/dsh-header-fix)
[![release](https://img.shields.io/github/v/release/yuyuanjingxuan/dsh-header-fix)](https://github.com/yuyuanjingxuan/dsh-header-fix/releases)
[![build](https://img.shields.io/github/actions/workflow/status/yuyuanjingxuan/dsh-header-fix/publish.yml)](https://github.com/yuyuanjingxuan/dsh-header-fix/actions/workflows/publish.yml)
[![issues](https://img.shields.io/github/issues/yuyuanjingxuan/dsh-header-fix)](https://github.com/yuyuanjingxuan/dsh-header-fix/issues)
[![license](https://img.shields.io/github/license/yuyuanjingxuan/dsh-header-fix?cacheSeconds=3600)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20x64-lightgrey)](#用法)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-0.2.1--rc.5%2B-4B32C3)](#版本情况)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933)](#用法)
[![Status](https://img.shields.io/badge/status-workaround-orange)](#这个补丁做了什么)

修复 DeepSeek Harness 的一个启动失败问题：

```
Error: desktop welcome: Web authentication failed
```

如果窗口一直不出现，或者闪一下就关掉，`logs\crash-*-host.log` 里反复出现上面这行，
那就是这个原因。

---

## 现象

- 双击图标没反应，或者窗口刚出来就消失
- `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-host.log` 里有：

  ```
  source: host
  phase: startup
  Error: desktop welcome: Web authentication failed
      at connectDesktopWelcome (.../app.asar/lib/main.js:8886)
  ```

- 重装没用，换网络没用，清缓存也没用
- 用一段时间之后才出现，而且会周期性复发

---

## 原因

每次启动时，桌面外壳会在 `127.0.0.1:<随机端口>` 上起一个本地 host，并签发一条
`dsh-auth-*` cookie 用来认证。

1. 端口每次都不一样（`--port 0`），所以每次启动都会签发一条新 cookie
2. 旧 cookie 从来不删，有效期 30 天
3. `connectDesktopWelcome()` 调用的是 `net.fetch(..., { credentials: "include" })`，
   Chromium 会把所有匹配 `127.0.0.1` 的 cookie 全部塞进 `Cookie` 头，不管端口
4. 每条 cookie 大约 227 字节。到第 71 条时这个头就有 16,186 字节，再加上常规的
   UA / accept / sec-fetch-* 等头，整个请求头是 16,555 字节，超过了 Node 默认的
   `http.maxHeaderSize`（16384）
5. host 返回 `431 Request Header Fields Too Large`，外壳把它当成认证失败，窗口就再也
   打不开了

跟网络、代理、账号、安装包都没关系。纯粹是启动次数的问题：大概 70 次左右就会踩到。

完整的排查过程在 [docs/ROOT-CAUSE.md](docs/ROOT-CAUSE.md)（英文）。

---

## 这个补丁做了什么

| 步骤 | 作用 |
|---|---|
| 改 `app.asar` | 把 host 里的 `createServer(listener)` 改成 `createServer({ maxHeaderSize: 65536 }, listener)`，上限从 16 KiB 提到 64 KiB |
| 清 cookie | 从 `Network\Cookies` 里删掉 `host_key='127.0.0.1'` 的 `dsh-auth-*` cookie |

补丁只动一个文件里的一处调用（`dsh-host-webserver/lib/index.js`，21,436 字节变成
21,458 字节），并重算这个文件的 asar `integrity` 哈希。其余 16,650 个文件逐字节不变。

---

## 用法

### 先退出应用

右键托盘图标退出，或者在任务管理器里结束所有 `DeepSeek Harness.exe`。
应用开着的时候工具会拒绝执行，因为 `Network\Cookies` 被占用。

### 打补丁

双击 `fix.bat`，或者在终端里：

```bat
fix.bat
```

它会通过卸载注册表项找到安装目录，找不到就退回
`%LOCALAPPDATA%\Programs\DeepSeek Harness`，然后用应用自带的 Node 运行时执行。
不需要额外装任何东西。

装在别的位置：

```bat
fix.bat apply "D:\Apps\DeepSeek Harness"
```

### 用 npx

如果 PATH 里有 Node.js >= 22.5，不用克隆仓库：

```bash
npx dsh-header-fix            # 打补丁
npx dsh-header-fix check      # 查看状态
npx dsh-header-fix revert     # 撤销
npx dsh-clean-cookies         # 只清 cookie
```

安装目录的查找方式一样，所以不用传参数。要覆盖就传一个。

### 撤销

```bat
revert.bat
```

把 `resources\app.asar.orig` 复制回 `app.asar`。备份是第一次打补丁时生成的。

### 只看状态

```bat
fix.bat check     :: 安装目录、asar 大小、备份状态、是否已打补丁
fix.bat verify    :: 校验 asar 里全部 16,651 个文件的完整性
```

### 保守方案

如果不想改 `app.asar`，只清 cookie：

```bat
tools\clean-cookies.bat
```

或者用任意 Node.js >= 22.5：

```bash
node tools/clean-cookies.mjs --dry-run   # 先数一下
node tools/clean-cookies.mjs             # 再删
```

这个立刻见效，但大约 70 次启动之后又会复发。`fix.bat` 才是彻底的修法。

---

## 注意事项

- **自动更新会覆盖 `app.asar`**，补丁就没了。更新完重新跑一次 `fix.bat`。它是幂等的，
  已经打过补丁的会直接跳过。
- 备份 `app.asar.orig` 大约 174 MB，留在安装目录里。稳定之后可以删，但删了
  `revert.bat` 就不能用了，只能重装。
- 补丁不碰用户设置、凭据和模型配置。
- 如果 `check` 报 `found N patch anchors, expected exactly 1`，说明 DeepSeek 改了那段
  代码。工具会直接停下，不写任何东西。请带上版本号开个 issue。

---

## 文件

```
fix.bat                    一键打补丁，自己找安装目录
revert.bat                 一键撤销
patch.mjs                  apply / revert / check / verify
tools/clean-cookies.mjs    独立的 cookie 清理
tools/clean-cookies.bat    上面那个的 Windows 包装
docs/ROOT-CAUSE.md         排查记录、实测数据、asar 格式细节
```

`patch.mjs` 也能跑在任意 Node.js >= 22 上：

```bash
node patch.mjs apply "/path/to/DeepSeek Harness"
```

---

## 测试环境

- DeepSeek Harness **0.2.1-rc.5**，Windows x64，Electron 44.7.0 / Node 24.21.0
- 打补丁之后：16,651 个文件哈希全部匹配；向 host 端口发 20,000 字节的请求头返回
  `401 Unauthorized` 而不是 `431`；应用正常启动，五个进程都在。

### 版本情况

| 版本 | 上游是否修复 |
|---|---|
| 0.2.1-rc.5 | 否 |
| 0.2.2-rc.1（当前 nightly feed） | 否。`dsh-client-connection` 逐字节相同，`createServer` 调用也没变 |

升级没用。补丁对最新版同样适用。

---

## 建议的上游修法

两个里随便哪个都行：

1. 让 `BrowserAuth` 在签发新 cookie 之前，把同一个 host 下其他的 `dsh-auth-*` 清掉。
   旧端口的 cookie 本来就失效了，删了不损失什么。
2. 在 `dsh-host-webserver` 里给 `createServer` 传 `{ maxHeaderSize: 65536 }`。一行的事。

---

## 许可

[MIT](LICENSE)
