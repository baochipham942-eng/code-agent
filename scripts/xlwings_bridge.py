#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
xlwings Bridge - Excel 自动化桥接脚本

支持的操作:
- read: 读取单元格/范围
- write: 写入单元格/范围
- run_macro: 执行 VBA 宏
- get_active: 获取当前活动工作簿信息
- list_sheets: 列出所有工作表
- create_chart: 创建图表

依赖: pip install xlwings
"""

import sys
import json
import argparse
from typing import Any, Dict, List, Optional

def check_xlwings() -> bool:
    """检查 xlwings 是否可用"""
    try:
        import xlwings as xw
        return True
    except ImportError:
        return False

def check_excel() -> bool:
    """检查 Excel 是否可用"""
    try:
        import xlwings as xw
        # 尝试连接 Excel
        app = xw.App(visible=False)
        app.quit()
        return True
    except Exception:
        return False

def read_range(
    file_path: Optional[str] = None,
    sheet: Optional[str] = None,
    range_addr: str = "A1",
    as_values: bool = True
) -> Dict[str, Any]:
    """读取 Excel 范围"""
    import xlwings as xw

    try:
        if file_path:
            wb = xw.Book(file_path)
        else:
            wb = xw.books.active
            if wb is None:
                return {"success": False, "error": "没有打开的工作簿"}

        ws = wb.sheets[sheet] if sheet else wb.sheets.active
        rng = ws.range(range_addr)

        if as_values:
            data = rng.value
            # 处理单个值和二维数组
            if isinstance(data, list):
                # 确保是二维列表
                if data and not isinstance(data[0], list):
                    data = [data]
            else:
                data = [[data]]
        else:
            data = str(rng.value)

        result = {
            "success": True,
            "data": data,
            "workbook": wb.name,
            "sheet": ws.name,
            "range": range_addr,
            "rows": rng.rows.count,
            "cols": rng.columns.count
        }

        # 如果是打开的文件，不关闭
        if file_path:
            wb.close()

        return result
    except Exception as e:
        return {"success": False, "error": str(e)}

def write_range(
    file_path: Optional[str] = None,
    sheet: Optional[str] = None,
    range_addr: str = "A1",
    data: Any = None,
    save: bool = True
) -> Dict[str, Any]:
    """写入 Excel 范围"""
    import xlwings as xw

    try:
        if file_path:
            wb = xw.Book(file_path)
        else:
            wb = xw.books.active
            if wb is None:
                return {"success": False, "error": "没有打开的工作簿"}

        ws = wb.sheets[sheet] if sheet else wb.sheets.active
        ws.range(range_addr).value = data

        if save:
            wb.save()

        result = {
            "success": True,
            "message": f"已写入 {ws.name}!{range_addr}",
            "workbook": wb.name,
            "sheet": ws.name
        }

        if file_path:
            wb.close()

        return result
    except Exception as e:
        return {"success": False, "error": str(e)}

def run_macro(
    file_path: Optional[str] = None,
    macro_name: str = "",
    args: Optional[List[Any]] = None
) -> Dict[str, Any]:
    """执行 VBA 宏"""
    import xlwings as xw

    try:
        if file_path:
            wb = xw.Book(file_path)
        else:
            wb = xw.books.active
            if wb is None:
                return {"success": False, "error": "没有打开的工作簿"}

        macro = wb.macro(macro_name)

        if args:
            result_value = macro(*args)
        else:
            result_value = macro()

        result = {
            "success": True,
            "message": f"宏 '{macro_name}' 执行完成",
            "return_value": result_value,
            "workbook": wb.name
        }

        if file_path:
            wb.close()

        return result
    except Exception as e:
        return {"success": False, "error": str(e)}

def get_active_info() -> Dict[str, Any]:
    """获取当前活动工作簿信息"""
    import xlwings as xw

    try:
        wb = xw.books.active
        if wb is None:
            return {"success": False, "error": "没有打开的工作簿"}

        sheets_info = []
        for ws in wb.sheets:
            used_range = ws.used_range
            sheets_info.append({
                "name": ws.name,
                "used_range": used_range.address if used_range else None,
                "rows": used_range.rows.count if used_range else 0,
                "cols": used_range.columns.count if used_range else 0
            })

        return {
            "success": True,
            "workbook": wb.name,
            "path": wb.fullname,
            "sheets": sheets_info,
            "active_sheet": wb.sheets.active.name
        }
    except Exception as e:
        return {"success": False, "error": str(e)}

def list_sheets(file_path: Optional[str] = None) -> Dict[str, Any]:
    """列出所有工作表"""
    import xlwings as xw

    try:
        if file_path:
            wb = xw.Book(file_path)
        else:
            wb = xw.books.active
            if wb is None:
                return {"success": False, "error": "没有打开的工作簿"}

        sheets = [ws.name for ws in wb.sheets]

        result = {
            "success": True,
            "workbook": wb.name,
            "sheets": sheets,
            "count": len(sheets)
        }

        if file_path:
            wb.close()

        return result
    except Exception as e:
        return {"success": False, "error": str(e)}

def create_chart(
    file_path: Optional[str] = None,
    sheet: Optional[str] = None,
    data_range: str = "A1:B10",
    chart_type: str = "line",
    title: str = "",
    position: str = "E1"
) -> Dict[str, Any]:
    """创建图表"""
    import xlwings as xw

    try:
        if file_path:
            wb = xw.Book(file_path)
        else:
            wb = xw.books.active
            if wb is None:
                return {"success": False, "error": "没有打开的工作簿"}

        ws = wb.sheets[sheet] if sheet else wb.sheets.active

        # 图表类型映射
        chart_types = {
            "line": "line",
            "bar": "bar_clustered",
            "column": "column_clustered",
            "pie": "pie",
            "scatter": "xy_scatter",
            "area": "area"
        }

        ct = chart_types.get(chart_type, "line")

        chart = ws.charts.add(
            left=ws.range(position).left,
            top=ws.range(position).top
        )
        chart.set_source_data(ws.range(data_range))
        chart.chart_type = ct

        if title:
            chart.api.HasTitle = True
            chart.api.ChartTitle.Text = title

        wb.save()

        result = {
            "success": True,
            "message": f"图表已创建在 {ws.name}!{position}",
            "chart_type": chart_type,
            "data_range": data_range
        }

        if file_path:
            wb.close()

        return result
    except Exception as e:
        return {"success": False, "error": str(e)}

def main():
    parser = argparse.ArgumentParser(description="xlwings Bridge")
    parser.add_argument("--check", action="store_true", help="检查环境")
    parser.add_argument("--operation", type=str, help="操作类型")
    parser.add_argument("--params", type=str, help="JSON 参数")

    args = parser.parse_args()

    # 环境检查
    if args.check:
        result = {
            "xlwings_available": check_xlwings(),
            "excel_available": check_excel() if check_xlwings() else False
        }
        print(json.dumps(result, ensure_ascii=False))
        return

    if not args.operation:
        print(json.dumps({"success": False, "error": "未指定操作"}))
        return

    # 解析参数
    params = json.loads(args.params) if args.params else {}

    # 执行操作
    operations = {
        "read": read_range,
        "write": write_range,
        "run_macro": run_macro,
        "get_active": get_active_info,
        "list_sheets": list_sheets,
        "create_chart": create_chart
    }

    op_func = operations.get(args.operation)
    if not op_func:
        print(json.dumps({"success": False, "error": f"未知操作: {args.operation}"}))
        return

    result = op_func(**params)
    print(json.dumps(result, ensure_ascii=False, default=str))

if __name__ == "__main__":
    main()
