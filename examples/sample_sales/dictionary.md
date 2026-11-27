# 电商多表演示数据业务字典（Sample Sales）

## 1. 表粒度说明

- `customers`：客户维度表，1 行 = 1 位注册客户（主键 `customer_id`），包含所在大区 `region` 与注册时间。
- `orders`：订单主表，1 行 = 1 笔订单（主键 `order_id`），包含下单日期 `order_date`、渠道 `channel`、状态 `status`。
- `order_items`：订单商品明细表，1 行 = 1 个订单商品行（与 `orders` 为 N:1 关系），包含品类 `category`、单价 `unit_price`、数量 `quantity`、折扣 `discount_amount`。
- `payments`：支付流水表，1 行 = 1 笔支付记录（与 `orders` 为 N:1 关系），包含支付方式 `payment_method`、实付金额 `paid_amount`。

## 2. 核心电商指标口径

- **有效订单（Valid Orders）**：`orders.status IN ('completed', 'paid')`，排除 `cancelled` 与 `refunded`。
- **商品成交总额（GMV）**：`SUM(oi.unit_price * oi.quantity)`。
- **净销售额（Net Sales）**：`SUM(oi.unit_price * oi.quantity - oi.discount_amount)`。
- **实付总额（Paid Amount）**：`SUM(p.paid_amount)`（仅统计支付成功流水）。
- **客单价（AOV）**：`有效订单实付总额 / COUNT(DISTINCT 有效 order_id)`。
- **退款率 / 取消率**：`COUNT(DISTINCT CASE WHEN status = 'refunded' THEN order_id END) * 1.0 / COUNT(DISTINCT order_id)`。
- **复购率（Repeat Buyer Rate）**：有效订单数 >= 2 的客户数占比。

## 3. 防扇出建模约定

- 同时统计商品明细（`order_items`）与支付流水（`payments`）时，**禁止直接 `orders JOIN order_items JOIN payments`**，必须使用 CTE 先按 `order_id` 分别聚合后再关联。
