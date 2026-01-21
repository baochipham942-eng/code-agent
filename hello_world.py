#!/usr/bin/env python3
# -*- coding: utf-8 -*-

def main():
    """主函数：打印 Hello World"""
    print("Hello, World!")
    print("欢迎来到 Python 编程世界！")
    
    # 添加一些额外的信息
    print(f"Python 版本: {__import__('sys').version}")
    print(f"当前时间: {__import__('datetime').datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

if __name__ == "__main__":
    main()