#!/usr/bin/env python3
"""
PDF Tools - PDF 合并/拆分/表格提取/转 DOCX
"""

import argparse
import json
import os
import sys


def merge_pdfs(params):
    """合并多个 PDF"""
    try:
        from pypdf import PdfMerger
    except ImportError:
        return {'success': False, 'error': '需要安装 pypdf: pip install pypdf'}

    input_files = params.get('input_files', [])
    output_path = params.get('output_path')

    if not input_files or len(input_files) < 2:
        return {'success': False, 'error': '至少需要 2 个输入文件'}
    if not output_path:
        return {'success': False, 'error': '需要指定 output_path'}

    for f in input_files:
        if not os.path.exists(f):
            return {'success': False, 'error': f'文件不存在: {f}'}

    merger = PdfMerger()
    try:
        for f in input_files:
            merger.append(f)
        merger.write(output_path)
        merger.close()

        size = os.path.getsize(output_path)
        return {
            'success': True,
            'output_path': output_path,
            'input_count': len(input_files),
            'file_size': size,
        }
    except Exception as e:
        return {'success': False, 'error': str(e)}


def split_pdf(params):
    """按页码范围拆分 PDF"""
    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError:
        return {'success': False, 'error': '需要安装 pypdf: pip install pypdf'}

    input_path = params.get('input_path')
    ranges = params.get('ranges', [])  # e.g. [{"start": 0, "end": 3, "output": "part1.pdf"}]

    if not input_path or not os.path.exists(input_path):
        return {'success': False, 'error': f'文件不存在: {input_path}'}
    if not ranges:
        return {'success': False, 'error': '需要指定 ranges'}

    reader = PdfReader(input_path)
    total_pages = len(reader.pages)
    outputs = []

    try:
        for r in ranges:
            start = r.get('start', 0)
            end = r.get('end', total_pages)
            output = r.get('output')

            if not output:
                return {'success': False, 'error': '每个 range 需要指定 output'}
            if start < 0 or end > total_pages or start >= end:
                return {'success': False, 'error': f'无效的页码范围: {start}-{end} (总页数: {total_pages})'}

            writer = PdfWriter()
            for i in range(start, end):
                writer.add_page(reader.pages[i])
            writer.write(output)
            writer.close()

            outputs.append({
                'output_path': output,
                'pages': f'{start + 1}-{end}',
                'page_count': end - start,
                'file_size': os.path.getsize(output),
            })

        return {
            'success': True,
            'total_pages': total_pages,
            'outputs': outputs,
        }
    except Exception as e:
        return {'success': False, 'error': str(e)}


def extract_tables(params):
    """从 PDF 中提取表格"""
    try:
        import pdfplumber
    except ImportError:
        return {'success': False, 'error': '需要安装 pdfplumber: pip install pdfplumber'}

    input_path = params.get('input_path')
    pages = params.get('pages')  # optional: list of page numbers (0-indexed)

    if not input_path or not os.path.exists(input_path):
        return {'success': False, 'error': f'文件不存在: {input_path}'}

    try:
        pdf = pdfplumber.open(input_path)
        all_tables = []

        target_pages = pages if pages else range(len(pdf.pages))

        for page_idx in target_pages:
            if page_idx >= len(pdf.pages):
                continue
            page = pdf.pages[page_idx]
            tables = page.extract_tables()
            for table_idx, table in enumerate(tables):
                all_tables.append({
                    'page': page_idx + 1,
                    'table_index': table_idx,
                    'rows': len(table),
                    'columns': len(table[0]) if table else 0,
                    'data': table,
                })

        pdf.close()

        return {
            'success': True,
            'total_tables': len(all_tables),
            'tables': all_tables,
        }
    except Exception as e:
        return {'success': False, 'error': str(e)}


def convert_to_docx(params):
    """PDF 转 DOCX"""
    try:
        from pdf2docx import Converter
    except ImportError:
        return {'success': False, 'error': '需要安装 pdf2docx: pip install pdf2docx'}

    input_path = params.get('input_path')
    output_path = params.get('output_path')
    start_page = params.get('start_page', 0)
    end_page = params.get('end_page')

    if not input_path or not os.path.exists(input_path):
        return {'success': False, 'error': f'文件不存在: {input_path}'}
    if not output_path:
        # 默认输出路径
        base = os.path.splitext(input_path)[0]
        output_path = f'{base}.docx'

    try:
        cv = Converter(input_path)
        cv.convert(output_path, start=start_page, end=end_page)
        cv.close()

        return {
            'success': True,
            'output_path': output_path,
            'file_size': os.path.getsize(output_path),
        }
    except Exception as e:
        return {'success': False, 'error': str(e)}


def main():
    parser = argparse.ArgumentParser(description='PDF Tools')
    parser.add_argument('--operation', required=True,
                        choices=['merge', 'split', 'extract_tables', 'convert_to_docx'],
                        help='Operation to perform')
    parser.add_argument('--params', required=True, help='JSON parameters')
    args = parser.parse_args()

    try:
        params = json.loads(args.params)
    except json.JSONDecodeError as e:
        print(json.dumps({'success': False, 'error': f'JSON 解析失败: {e}'}))
        sys.exit(1)

    operations = {
        'merge': merge_pdfs,
        'split': split_pdf,
        'extract_tables': extract_tables,
        'convert_to_docx': convert_to_docx,
    }

    result = operations[args.operation](params)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
