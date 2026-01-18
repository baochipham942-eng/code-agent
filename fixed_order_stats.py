from collections import defaultdict
from dataclasses import dataclass
from typing import List, Dict


@dataclass
class Order:
    order_id: str
    user_id: str
    amount: float
    status: str  # "PAID", "REFUNDED", "PENDING"


def build_user_totals(orders: List[Order]) -> Dict[str, float]:
    """
    目标：按 user_id 统计"已支付"订单金额合计；
    退款单不计入；PENDING 不计入。
    """
    totals = defaultdict(float)

    # 🔧 BUG 1 修复：过滤条件写错
    # 原代码：if o.status == "PAID" or "REFUNDED": 
    # 这会被解析为：if (o.status == "PAID") or ("REFUNDED"):
    # "REFUNDED" 作为字符串总是为 True，所以所有订单都会被计入！
    for o in orders:
        if o.status == "PAID":  # ✅ 只统计已支付订单
            totals[o.user_id] += o.amount

    # 🔧 BUG 2 修复：返回普通 dict
    # 原代码：return dict(zip(totals.keys(), totals.values()))
    # 问题：zip 会创建键值对，但 totals.values() 包含的是累加值
    # 正确做法：直接使用 dict(totals) 或 {k: v for k, v in totals.items()}
    return dict(totals)


if __name__ == "__main__":
    sample = [
        Order("o1", "u1", 100.0, "PAID"),
        Order("o2", "u1", 50.0, "PENDING"),
        Order("o3", "u2", 80.0, "REFUNDED"),
        Order("o4", "u2", 20.0, "PAID"),
    ]
    
    result = build_user_totals(sample)
    print("修复后的统计结果：")
    print(result)
    
    # 验证结果
    print("\n验证：")
    print(f"u1 用户：100.0 (PAID) + 50.0 (PENDING, 不计入) = {result.get('u1', 0)}")
    print(f"u2 用户：80.0 (REFUNDED, 不计入) + 20.0 (PAID) = {result.get('u2', 0)}")