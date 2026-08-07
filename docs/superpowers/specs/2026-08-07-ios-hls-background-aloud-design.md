# iOS HLS 后台全文朗读与定时按钮命中修复设计

## 背景与根因

当前全文朗读虽然复用同一个 `HTMLAudioElement`，但每个句子仍是独立的 Blob URL。每句结束后，`tts-player` 必须在 `ended` 回调里运行 JavaScript，获取下一句、替换 `src` 并再次调用 `play()`。iPhone 熄屏后，iOS 可以继续播放已经交给系统媒体进程的当前音频，却可能冻结页面脚本；因此当前句结束后无法切换下一句。

页面的 `visibilitychange` 处理只保存断点，并没有主动暂停。根因是逐句媒体资源在句间依赖页面调度，而不是 PWA 显隐状态处理。

悬浮朗读栏还有一个独立的触摸问题：点击定时按钮的闹钟 SVG 图标不能打开菜单，只有图标周围能够触发。现有 `pointer-events: none` CSS 补丁依赖 iOS 将 SVG 区域重新命中到透明按钮，并且自动化测试只检查 CSS 文本，没有验证真实 DOM 行为，所以没有消除真机问题。

目标设备为 iOS 18.6 的安装版 PWA。

## 目标

- iPhone 熄屏后由系统媒体播放器连续播放多个句子，不依赖页面 JavaScript 在句间换源。
- 保留现有 Azure TTS、R2 句级缓存、对话角色、语速、暂停/继续、断点、上一句、本句、下一句和完成统计。
- 通过能力检测启用原生 HLS；不支持原生 HLS 的浏览器继续使用现有逐句播放器。
- HLS 不可准备或不可播放时明确回退，不让全文朗读整体失效。
- 定时按钮的图标、文字和整个可见按钮区域都能可靠打开菜单。
- 用行为测试覆盖定时图标命中，不再只检查 CSS 规则存在。

## 非目标

- 不承诺 iOS 强制终止 PWA 进程后仍继续播放。
- 不承诺飞行模式下播放尚未被系统媒体缓存的 segment。
- 不把 Web Speech API 包装成后台媒体；Web Speech 仍只作为能力受限的最终降级。
- 不重新设计朗读工具栏、悬浮控制条或睡眠定时器。
- 不为非原生 HLS 浏览器引入 hls.js 或 Managed Media Source。
- 不改变 TTS 月度字符预算和现有完成次数规则。

## 方案选择

采用 iOS 原生 HLS 音频播放。Apple 平台原生支持 HLS，播放列表和 segment 请求由系统媒体栈管理，适合熄屏后的连续播放。每句仍是独立的缓存和逻辑 segment，因此无需牺牲角色选择和句级控制。

没有采用以下方案：

- 全文单个 MP3：后台稳定，但会受到单次合成长度限制，并削弱逐句定位和多角色切换。
- Managed Media Source：仍需要 JavaScript 持续填充缓冲区，不能解决页面脚本被冻结这一根本问题。
- 静音媒体或定时唤醒等保活技巧：不属于可靠的平台能力，且增加耗电和审核风险。

HLS Packed Audio segment 遵循 [RFC 8216 第 3.4 节](https://datatracker.ietf.org/doc/html/rfc8216#section-3.4)：每个 MP3 segment 开头包含 ID3 `PRIV` 帧，owner 为 `com.apple.streaming.transportStreamTimestamp`，值为该 segment 首个采样点的 33 位 MPEG-2 时间戳（90 kHz 时基）。

## 服务端架构

### 路由

新增三个同源、需登录的 GET 路由：

- `/api/tts/articles/:articleId/hls/prepare?profile=:profile`
- `/api/tts/articles/:articleId/hls/stream.m3u8?profile=:profile&v=:fingerprint`
- `/api/tts/articles/:articleId/hls/segments/:index.mp3?profile=:profile&v=:sentenceFingerprint`

`prepare` 返回：

```json
{
  "playlistUrl": "/api/tts/articles/a1/hls/stream.m3u8?profile=aria-narration&v=...",
  "fingerprint": "...",
  "sentences": [
    { "index": 0, "startSeconds": 0, "durationSeconds": 2.736 },
    { "index": 1, "startSeconds": 2.736, "durationSeconds": 3.024 }
  ],
  "durationSeconds": 5.76
}
```

时间值以 MP3 帧的采样数和采样率计算，不能按字符数或文件字节数猜测。服务端把 MP3 解析、HLS 时间线生成和 ID3 封装放在独立模块中，使 API 路由只处理鉴权、资源解析和响应。

### 准备流程

1. 鉴权并读取文章正文，使用现有 `splitArticleParagraphs` 和对话角色检测得到规范化句子资源。
2. 根据正文、TTS 缓存版本、实际声音角色和输出格式计算文章指纹；根据每句文本和实际角色计算句子指纹。
3. 对每句复用现有 R2 缓存键。缓存命中时读取 MP3；缓存缺失时沿用现有租约、预算、Azure 合成和 R2 写入流程。
4. 以受限并发准备缺失音频，避免一次向 Azure 发出无界请求。任一句无法准备时，整个 HLS 准备失败并返回现有 TTS 错误码语义。
5. 解析所有 MP3 帧，生成准确句子时长与累计时间轴。
6. 返回时间轴和带文章指纹的播放列表 URL。准备成功意味着播放列表引用的所有 segment 已经存在于 R2；熄屏播放期间不需要临时合成。

准备接口保持幂等。相同文章、声音和 TTS 缓存版本重复调用只读取已有缓存，不重复计费。文章正文或角色解析结果改变时，指纹随之改变；旧 R2 对象仍可按内容寻址复用或由存储生命周期清理。

### 播放列表

媒体播放列表使用 VOD 形式，并包含：

- `#EXTM3U`
- 与 Packed Audio 兼容的 `#EXT-X-VERSION`
- 向上取整且不小于最长 segment 的 `#EXT-X-TARGETDURATION`
- `#EXT-X-MEDIA-SEQUENCE:0`
- 每句准确的 `#EXTINF`
- 带句子指纹的同源 segment URL
- `#EXT-X-ENDLIST`

播放列表响应使用 `Content-Type: application/vnd.apple.mpegurl` 和 `Cache-Control: private, no-cache`。服务端重新校验文章指纹；URL 指纹与当前正文或 profile 不匹配时返回冲突响应，客户端重新执行准备流程，不能播放陈旧列表。

### Packed Audio segment

segment 接口重新鉴权并校验文章、索引、profile 和句子指纹，从 R2 读取已准备的原始 MP3，在响应前添加本 segment 的 ID3 传输时间戳。时间戳由准备阶段同一套 MP3 时间线算法确定。

segment 响应使用 `Content-Type: audio/mpeg`。URL 已含内容指纹，因此可使用私有长期不可变缓存。ID3 封装只影响 HLS 响应，不修改现有 R2 原始音频，也不影响普通逐句播放器。

## 客户端播放器

### 能力选择

`tts-player` 创建唯一音频元素后，通过：

```js
audio.canPlayType('application/vnd.apple.mpegurl')
```

检测原生 HLS。返回非空字符串时，全文朗读优先走 HLS；单词发音和单句点读仍走现有普通 MP3 路径。能力检测不使用 iPhone 或 Safari UA 字符串。

不支持原生 HLS、准备失败或 HLS 首次加载失败时，播放器切回现有逐句云音频；该路径继续允许 Web Speech 最终降级。

### 启动与恢复

开始全文朗读时：

1. 发布 `loading` 状态，并由阅读器显示“正在准备后台朗读”。
2. 请求 `prepare`，保存返回的时间轴。
3. 将同一个音频元素的 `src` 直接设为 `playlistUrl`，不先 `fetch()` 为 Blob。
4. `loadedmetadata` 后，把开始位置设置为目标句 `startSeconds + offsetSeconds`。句内 offset 超过该句时长时退回句首。
5. 在最初用户手势启动的异步调用链中执行 `play()`；若浏览器拒绝自动播放，保持可恢复的暂停状态并提示用户再次点击继续。

历史断点继续保存句子索引和句内秒数，不保存 HLS 全局秒数。这样正文指纹有效时可以映射到新播放会话，非 HLS 回退也能使用同一断点格式。

### 状态与句子映射

播放器通过准备接口返回的边界，把 `audio.currentTime` 映射为当前句和句内秒数。映射在以下事件执行：

- `play`、`pause`、`timeupdate`、`seeking`、`seeked`、`ended`；
- `visibilitychange` 恢复可见；
- `pageshow`。

熄屏期间即使 JavaScript 没有收到逐句事件，HLS 仍由系统连续播放。亮屏后立即用媒体当前时间重建当前句和句内位置，而不是假设仍停留在熄屏前的句子。

### 控制行为

- 暂停/继续：直接调用同一音频元素的 `pause()` / `play()`。
- 上一句：seek 到当前实际发声句前一句的 `startSeconds`；第一句禁用。
- 本句：seek 到当前句的 `startSeconds`。
- 下一句：seek 到下一句的 `startSeconds`；最后一句禁用。
- 语速：设置音频元素 `playbackRate`，保留现有 0.5–1.5 倍范围。
- Media Session：继续映射播放、暂停、上一句、本句和下一句。连续跨句不依赖 action handler；锁屏界面是否展示每个可选 action 仍由 iOS 决定。

seek 操作都把播放意图设为继续，并在 seek 完成后继续播放。正在加载或准备时的暂停会清除播放意图，准备完成后保持暂停，不能偷偷开始播放。

### 完成统计

播放器维护已自然跨过句尾的句子集合：

- 正向播放越过边界时，把被完整覆盖的句子加入集合。
- 从某句中部开始时，该句只有再次从句首播放并越过句尾才视为完整覆盖。
- 手动 seek 跳过的句子不计入集合。
- 回听已经完成的句子不会重复增加覆盖数量。
- 自然到达 HLS 末尾后，继续沿用“从第 0 句开始且覆盖率至少 80%”的完整朗读规则。

## 错误与回退

- HLS 准备失败：保留准备接口返回的具体错误语义，切回现有逐句播放器，并显示“后台连续播放暂不可用，已切换为普通朗读”。
- 播放列表指纹冲突：重新准备一次；再次冲突则停止 HLS 并回退。
- HLS 媒体错误：保存由当前媒体时间映射出的句子与句内位置，重新加载同一播放列表一次；仍失败则暂停并向用户提供普通朗读继续入口。
- segment 缺失或指纹不匹配：返回明确的 404/409，不能静默返回另一句音频。
- 本地存储不可用：继续使用内存和 D1 断点，不影响 HLS 播放。
- Web Speech 降级：保持现有“锁屏后台播放可能受限”提示。

睡眠定时器仍受 iOS 页面调度限制：如果熄屏期间 JavaScript 被完全冻结，定时到点可能只能在下一次媒体事件或亮屏时补做暂停。本次改动不宣称解决该平台限制。

## 定时按钮触摸修复

悬浮定时按钮不能再依靠 SVG 子节点的 `pointer-events: none` 让触摸“穿透”到透明父按钮。按钮自身提供覆盖完整可见区域的命中层；闹钟图标作为纯装饰渲染，不形成独立的触摸空洞。

事件处理要求：

- 图标、标签、倒计时数字和按钮留白都解析为同一个 `speech-floating-timer` 按钮。
- 触摸事件只打开一次菜单；后续合成的 `click` 不能造成立即关闭或重复创建。
- 键盘 Enter/Space 和辅助技术触发的标准 `click` 保持可用。
- 打开后 `aria-expanded="true"`，关闭后恢复 `false`，焦点恢复到实际按钮而不是图标节点。
- 倒计时开始后，图标被数字替换，完整按钮命中区域保持不变。

删除或收窄已经无效的全局 SVG 点击穿透规则，避免它继续掩盖真实行为。修复只改变事件命中，不改变按钮尺寸、位置或视觉样式。

## 安全与缓存

- 所有 HLS 路由沿用现有会话鉴权，并校验文章属于当前用户。
- 播放列表和 segment 只使用同源 URL，确保 iOS 媒体请求携带现有会话上下文。
- profile 必须属于现有 `TTS_PROFILES`；非法 profile 返回 400。
- index 必须是当前文章的有效句子索引。
- 播放列表不长期缓存；segment 只有在 URL 含正确内容指纹时才允许不可变缓存。
- HLS 准备使用现有生成租约，避免并发准备造成重复 Azure 计费。

## 模块边界

- `src/tts-api.js`：复用并暴露句子资源解析、缓存读取和合成能力，不负责 HLS 文本格式。
- 新的 HLS 服务模块：MP3 帧解析、时间线、ID3 `PRIV` 封装、播放列表生成和 HLS 路由响应。
- `src/index.js`：只增加经过鉴权的 HLS 路由分发。
- `public/lib/tts-player.js`：能力选择、准备请求、HLS 媒体状态、seek 控制、错误回退和完成统计。
- `public/reader-view.js`：渲染准备/回退状态，保持现有订阅接口；修复定时按钮命中。
- `public/mobile-fixes.css` / `public/styles.css`：只保留按钮完整命中层所需样式，移除不可靠的全局穿透假设。

## 自动化测试

### 服务端

- MP3 帧解析得到准确采样率、帧数和秒数；损坏或不支持的 MP3 返回受控错误。
- ID3 `PRIV` owner、8 字节时间戳和 33 位/90 kHz 计算符合 RFC 8216。
- 播放列表包含准确 `EXTINF`、合法 `TARGETDURATION`、指纹 segment URL 和 `ENDLIST`。
- `prepare` 复用已有 R2 缓存，缺失时只合成一次；并发准备受租约保护。
- 正文、profile、句子索引和指纹校验；跨用户访问拒绝。
- 准备中任一句失败时不返回半完整播放列表。

### 播放器

- `canPlayType` 支持时全文选择 HLS，不支持时保持现有逐句路径。
- 准备期间发布 loading；暂停意图可阻止准备完成后自动播放。
- 断点映射到正确 HLS 全局时间，越界句内 offset 回到句首。
- 当前时间映射到正确句子和句内秒数，亮屏后可跨越多个后台句子重新同步。
- 上一句、本句和下一句 seek 到准确边界并继续播放。
- 手动跳过不增加覆盖率，自然跨过才增加，80% 完成规则不变。
- HLS 准备失败、首次媒体失败、一次重试和普通朗读回退。

### DOM 与触摸

- 直接在闹钟图标节点触发真实冒泡事件会打开定时菜单。
- 点击图标外围、文字和倒计时数字得到相同行为。
- 一个触摸序列只创建一个菜单。
- Enter/Space 激活、`aria-expanded` 和关闭后的焦点恢复。
- 测试断言实际 DOM 结果，不能仅匹配 CSS 字符串。

## 真机验收

在 iOS 18.6 安装版 PWA 上执行：

1. 首次朗读未缓存文章，确认出现准备状态并在准备完成后播放。
2. 熄屏并跨越至少五个句子，确认没有在句尾停止。
3. 从锁屏界面暂停、继续，并验证系统提供的上一句/下一句入口。
4. 亮屏后确认当前高亮句和句内断点与实际声音一致。
5. 暂停后退出并重新进入文章，确认从句子和句内位置继续。
6. 分别点击悬浮定时按钮的闹钟图标、文字和留白，确认都只打开一次菜单。
7. 设置倒计时后点击数字区域，确认仍能重新打开菜单。
8. 模拟 Azure/R2 或 HLS 请求失败，确认普通朗读回退与提示准确。

自动化测试不能模拟 iOS 熄屏调度，因此真机跨句验收是完成本功能的必要条件。
