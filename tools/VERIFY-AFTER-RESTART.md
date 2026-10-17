# 重启后验证清单（dsh-modeler）

> 为什么必须重启：`dsh.client` 的 bundle 清单是 **host 启动时**组合进 boot graph 的。
> 换掉 profile 之后只刷新页面拿不到 client 半边；host 那三个工具也要重启才注册。

## 一、重启

```powershell
& powershell -NoProfile -ExecutionPolicy Bypass -File .\restart-dsh.ps1
```

（会关掉当前窗口；会话记录保留在 DSH 的 sessions 目录，回来后点侧栏即可继续。）

## 二、看入口按钮

**左侧栏底部、「设置」上方**应当出现：

```
◧ 三视图建模
```

点它 → 弹出一个居中的大面板（宽度 `min(1080px, 94vw)`）。点遮罩或按 `Esc` 可关。

- [ ] 按钮出现
- [ ] 点击能打开面板
- [ ] `Esc` 能关闭

> 如果**按钮没出现**：说明 client bundle 没被加载。
> 打开 DevTools（`Ctrl+Shift+I`）→ Console，看有没有 `dsh-modeler` 相关的报错；
> 再看 Network 里有没有请求 `/plugins/dsh-modeler/client.js`（状态码应为 200）。
> 把报错原文贴出来即可定位。

## 三、拖三张图进去

用包内现成的夹具（`samples\`）：

| 槽位 | 拖这张 |
|---|---|
| 前视图 | `box-front.png`（120×60） |
| 侧视图 | `box-side.png`（40×60） |
| 俯视图 | `box-top.png`（120×40） |

- [ ] 拖完自动出模型（蓝色实体，可拖动旋转、滚轮缩放）
- [ ] 底部统计显示：顶点/三角形/体素网格 `120×60×40`、**水密 ✓ 是**、体积约 0.2222
- [ ] 三张卡片的预览图是"青色实体 + 红框内容框"

换更有意思的：`sphere-*`（三张圆）、`cone-*`（三角+圆）、`torus-ish-*`（带方孔方板 —— 中心应该**是空的**，验证通孔没被填掉）。

- [ ] `torus-ish` 重建出来中间有方孔
- [ ] `cone` 重建出尖顶

## 四、调参

- [ ] 拖「分辨率」滑块（24→192），模型立即重算
- [ ] 拖「平滑」（0→4），表面台阶感变化
- [ ] 开「线框」看到三角网格
- [ ] 点「复位视角」，相机回到框住模型的默认位置

## 五、导出

- [ ] 「导出 OBJ」→ 浏览器下载 `model.obj`
- [ ] 「导出 STL」→ 下载 `model.stl`
- [ ] 「导出 GLB」→ 下载 `model.glb`

拿导出的 `.stl` 用 Windows 的「3D 查看器」打开，形状应与面板里一致。

- [ ] STL 能被 3D 查看器打开

## 六、host 工具

重启后新开一个会话，工具列表里应多出三个：

- [ ] `modeler_save`
- [ ] `modeler_load`
- [ ] `modeler_views`

也可以用一句话验证，比如：

> 用 samples 里的 box 三视图建个模，导出 STL 到工作区，再切片回三视图给我看。

Agent 应当依次调 `modeler_views`（或先 `modeler_save`），并给出 PNG 路径。

---

## 附：已自动验证过的部分（无需重复）

跑 `tools\verify-all.ps1`，8 步全绿：

| 步骤 | 覆盖 |
|---|---|
| `selftest.test.mjs` | 核心算法 39 项回归 |
| `verify-fixtures.py` | 用 Pillow 独立解码 24 张夹具 |
| `smoke-client.mjs` | 客户端 bundle 的 DSH 协议 / react 外部化 / 槽位注册 |
| `verify-host.mjs` | host 三工具真实调用、产物回读、切片 PNG 可解 |
| `verify-ui.mjs` | 记录型 React shim 真实渲染组件树 |
| `dump-carve.mjs` | 刷新跨语言对数基准 |
| `expect-voxels.py` | **Python 独立实现**逐体素算期望值 |
| `verify-pipeline.mjs` | 端到端：磁盘 PNG → 网格，与独立实现逐体素一致 |

**只有"按钮真的出现在 GUI 里"这件事必须靠重启后的这次人工确认** —— 它是整个目标的
最后一步，前面的自动化验证覆盖不到 boot graph 的加载路径。
