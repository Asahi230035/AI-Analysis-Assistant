# 短视频与线上用户行为分析业务字典（Short Video & User Behavior）

本数据集模拟短视频内容平台与带货转化业务，包含创作者（`creators`）、短视频内容表现（`videos`）与线上用户观看/互动/转化行为日志（`user_events`）三张核心表。

## 1. 播放与留存指标

- **VV（播放量）**：`SUM(videos.views)` 或 `COUNT(*) WHERE event_type = 'video_play'`。
- **有效播放（Valid Play）**：用户行为日志中 `watch_duration_sec >= 3` 的播放记录。
- **完播率（Completion Rate）**：`AVG(is_completed)` 或 `SUM(is_completed) * 1.0 / COUNT(*)`。
- **3 秒留存率（Hook Rate）**：`SUM(CASE WHEN watch_duration_sec >= 3 THEN 1 ELSE 0 END) * 1.0 / COUNT(*)`。
- **平均播完比（Avg Watch Ratio）**：`AVG(LEAST(watch_duration_sec * 1.0 / NULLIF(video_duration_sec, 0), 1.0))`。

## 2. 互动与公私域流量口径

- **综合互动率（ER, Engagement Rate）**：`(SUM(likes) + SUM(comments) + SUM(shares) + SUM(favorites)) * 1.0 / NULLIF(SUM(views), 0)`。
- **点赞率 / 转发率**：`SUM(likes) / SUM(views)`、`SUM(shares) / SUM(views)`。
- **流量来源（`traffic_source`）**：
  - `for_you`：公域推荐流（核心算法分发）
  - `following`：关注页私域流量
  - `search`：主动搜索流量
  - `paid_boost`：付费加热（DOU+/千川投放）

## 3. 短视频带货与用户行为转化

- **GPM（千次播放成交额）**：`SUM(gmv) / NULLIF(SUM(views) / 1000.0, 0)`。
- **商品卡点击率（CTR）**：`SUM(product_clicks) * 1.0 / NULLIF(SUM(views), 0)`。
- **短视频带货转化率（CVR）**：`SUM(orders_count) * 1.0 / NULLIF(SUM(product_clicks), 0)`。
- **创作者分层（`creator_tier`）**：`head`（头部达人）、`mid`（腰部达人）、`tail`（尾部创作者）。
- **用户留存标记**：`user_events.d1_retained = 1` 表示该用户在次日仍返回平台活跃。
