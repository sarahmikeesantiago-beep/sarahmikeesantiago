# 触感图谱 Web Demo

这是从现有 Unity Demo 独立出来的原生网页原型。它不会替换或修改 Unity 场景，当前包含：

- 旋钮、凸起、化石、橡胶四章纵向滚动展示；
- 右侧章节刻度和底部横向导航；
- 鼠标、触摸和红外触摸框统一使用 Pointer Events；
- 旋钮角度交互与三种图片滑动交互；
- 与 Unity 冻结基线一致的 64 字节触觉有效载荷格式，以及 65 字节桌面报告自检；
- WebHID 仅允许选择 `VID_674E/PID_0003`，并要求唯一的 64 字节输出报告；
- 真实输出默认关闭，协议自检通过后才允许手动开启；
- 实时信号采用“在途一条、待发最新值覆盖”，避免慢写入重放旧触摸轨迹；
- STOP 具有队列优先权，会丢弃尚未发送的旧信号；
- 已授权且唯一匹配的 HID 可在刷新后恢复连接，但触觉输出仍保持关闭；
- 独立的 [diagnostics.html](diagnostics.html) 只记录环境与 Pointer Events，并只读枚举已授权 HID；
- 350 ms 无新交互自动发送停止包，HID 写入超时会关闭并锁定设备；
- 明暗主题、窄屏布局和 reduced-motion 降级。

## 项目定位

这是交互、协议和硬件通信原型，不是类别路由或图像特异触觉生成的实验结果：

- 对象类别由用户手动选择，页面没有自动分类模型；
- 旋钮使用拖动速度规则，凸起与橡胶使用固定波形参数；
- 化石使用局部灰度差启发式，并把输出限制在 7–42 Hz；
- 网页仅声明协议格式与冻结数据包一致，不声明化石算法与 Unity 旧实现等价；
- 图片采用 object-fit: cover 显示时，触摸坐标会补偿居中裁剪，并按原图顶部到下方的方向取样。

## 预览

仅查看界面时，可以直接打开 `index.html`。

双击 `启动网页预览.bat` 会启动仅本机可访问的预览地址，并自动打开浏览器。

要测试 WebHID，请使用桌面版 Chrome 或 Edge 打开该本地地址。生产部署需要 HTTPS。

如意车机与红外触摸框应先打开 [diagnostics.html](diagnostics.html)。该页面不会请求新设备权限、不会打开 HID、不会发送触觉信号；完成触摸测试后可导出 JSON。

## 安全边界

- 连接设备或恢复已授权设备后都不会自动发送触觉信号，必须再次点击“触觉输出：关闭”手动开启。
- [diagnostics.html](diagnostics.html) 与触觉传输层完全分离，只调用 navigator.hid.getDevices() 做只读枚举。
- 当前目标设备标识来自现有 EVdemo 记录；首次实机连接仍需确认板卡确实为 `VID_674E/PID_0003`，且描述符包含唯一的 64 字节输出报告。
- 页面失焦、触摸结束、取消、切换章节或关闭输出时会发送停止有效载荷。
- 页面会对信号与停止包排序；停止请求会使此前尚未发送的信号失效。
- 连续 350 ms 没有新的有效交互时自动停止，写入失败或超时后必须重新连接设备。

## 如意诊断格式 v2

诊断 JSON 固定写入 "buildRevision: ruyi-web-v1.1.1" 与
"diagnosticsSchemaVersion: ruyi-input-diagnostics-v2"。触摸摘要把不同含义的量分开记录：

- maxDistanceFromStartPx：一次触点相对按下起点的最大移动范围；
- stationaryDriftRadiusPx：只在用户显式开始的静止测试阶段内统计；
- pointerMoveStepDistanceP95Px：红外坐标相邻移动步长的第 95 百分位；
- pointerCancelCount、lostPointerCaptureCount：原始结束事件计数；
- unexpectedLostPointerCaptureCount：触点仍活动时发生的捕获丢失。正常 pointerup 后跟随的 lostpointercapture 会保留在原始计数中，但不会算作异常。

## 可复现测试

仓库包含 Node.js 模拟 HID、浏览器交互、零输出诊断、布局截图和静态部署冒烟测试。所有设备路径都使用模拟对象或明确的空设备列表，不连接、打开或写入实体 HID。

~~~powershell
npm ci
npx playwright install chromium
npm test
~~~

Windows 默认使用已安装的 Microsoft Edge；Linux CI 使用 Playwright Chromium。也可以通过 PLAYWRIGHT_CHANNEL 显式指定浏览器通道。每次推送到 main 时，GitHub Actions 会重跑相同测试并保存页面截图。