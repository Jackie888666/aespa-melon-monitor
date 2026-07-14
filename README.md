# aespa 8/7 Melon Global 内场回流票监控

这是一个面向 iPad Gear Browser 和 Tampermonkey 的只读用户脚本，用于监控：

- 活动：aespa SYNK : COMPLaeXITY
- Melon Global 产品：`prodId=213414`
- 场次：2026-08-07 19:00 KST
- 区域：F1–F16 内场
- 提醒：Bark 推送

脚本只读取 Melon 页面已经请求到的余票汇总，并在当前登录会话中低频复查。它不会自动排队、绕过验证、点击座位、锁票或下单。

## iPad 推荐安装方式

1. 从 App Store 安装 [Gear Browser](https://apps.apple.com/us/app/gear-ai-web-extension-browser/id1458962238)。
2. 在 Gear 中打开下面的 Raw 地址并安装 UserScript：

   `https://raw.githubusercontent.com/Jackie888666/aespa-melon-monitor/main/aespa-melon-global-floor-monitor.user.js`

3. 如果只显示脚本文本，请保存为 `.user.js` 文件，再从 Gear 的 UserScript 管理器导入。
4. 使用 Gear 登录 Melon Global，打开[活动页面](https://tkglobal.melon.com/performance/index.htm?langCd=EN&prodId=213414)。
5. 手动选择 8 月 7 日场并进入选座页面。
6. 点击页面右下角的“设置 / 测试”：
   - 点击“设置 Bark 地址”，粘贴 Bark App 中的完整地址。
   - 点击“测试 Bark 推送”，确认手机可以收到通知。
7. 页面显示“正在监控 8/7 内场”即表示已捕获正确余票接口。

## 运行限制

- Gear 必须保持在前台，iPad 屏幕不能锁定；iPadOS 可能暂停后台网页计时器。
- Melon 的余票接口依赖当前登录会话和选定场次，因此 GitHub Actions 不负责实际查票。
- 默认每 30 秒检查一次，可设置为 20–300 秒。请不要使用高频请求。
- Bark 地址只保存在当前用户脚本管理器的本地存储中，不应写进仓库或发到聊天中。
- 同一批余票不会重复推送；余票清零后再次出现会重新提醒。

## GitHub Actions

仓库工作流仅使用 `node --check` 检查脚本语法，不会登录 Melon、调用余票接口或发送 Bark。
