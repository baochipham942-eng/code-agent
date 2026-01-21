#!/usr/bin/env python3
"""
HTTP 状态码表格生成器
生成格式化的 HTTP 状态码表格
"""

def generate_status_codes_table():
    """生成 HTTP 状态码表格"""
    
    # HTTP 状态码数据
    status_codes = [
        # 1xx: 信息响应
        {"code": 100, "name": "Continue", "category": "信息响应", "description": "继续。客户端应继续其请求"},
        {"code": 101, "name": "Switching Protocols", "category": "信息响应", "description": "切换协议。服务器根据客户端的请求切换协议"},
        {"code": 102, "name": "Processing", "category": "信息响应", "description": "处理中。服务器已收到请求，正在处理"},
        {"code": 103, "name": "Early Hints", "category": "信息响应", "description": "早期提示。用于在最终 HTTP 消息之前返回一些响应头"},
        
        # 2xx: 成功响应
        {"code": 200, "name": "OK", "category": "成功响应", "description": "请求成功。一般用于 GET 与 POST 请求"},
        {"code": 201, "name": "Created", "category": "成功响应", "description": "已创建。成功请求并创建了新的资源"},
        {"code": 202, "name": "Accepted", "category": "成功响应", "description": "已接受。已经接受请求，但未处理完成"},
        {"code": 203, "name": "Non-Authoritative Information", "category": "成功响应", "description": "非授权信息。请求成功，但返回的 meta 信息不在原始服务器"},
        {"code": 204, "name": "No Content", "category": "成功响应", "description": "无内容。服务器成功处理，但未返回内容"},
        {"code": 205, "name": "Reset Content", "category": "成功响应", "description": "重置内容。服务器处理成功，用户终端应重置文档视图"},
        {"code": 206, "name": "Partial Content", "category": "成功响应", "description": "部分内容。服务器成功处理了部分 GET 请求"},
        {"code": 207, "name": "Multi-Status", "category": "成功响应", "description": "多状态。消息体将是一个 XML 消息"},
        {"code": 208, "name": "Already Reported", "category": "成功响应", "description": "已报告。DAV 绑定的成员已在多状态响应中枚举"},
        {"code": 226, "name": "IM Used", "category": "成功响应", "description": "IM 已使用。服务器已完成对资源的 GET 请求"},
        
        # 3xx: 重定向
        {"code": 300, "name": "Multiple Choices", "category": "重定向", "description": "多种选择。请求的资源可包括多个位置"},
        {"code": 301, "name": "Moved Permanently", "category": "重定向", "description": "永久移动。请求的资源已被永久的移动到新 URI"},
        {"code": 302, "name": "Found", "category": "重定向", "description": "临时移动。请求的资源临时从不同的 URI 响应请求"},
        {"code": 303, "name": "See Other", "category": "重定向", "description": "查看其它地址。对应当前请求的响应可以在另一个 URI 上被找到"},
        {"code": 304, "name": "Not Modified", "category": "重定向", "description": "未修改。所请求的资源未修改，服务器返回此状态码时，不会返回任何资源"},
        {"code": 305, "name": "Use Proxy", "category": "重定向", "description": "使用代理。所请求的资源必须通过代理访问"},
        {"code": 306, "name": "Unused", "category": "重定向", "description": "已经被废弃的 HTTP 状态码"},
        {"code": 307, "name": "Temporary Redirect", "category": "重定向", "description": "临时重定向。请求的资源临时从不同的 URI 响应请求"},
        {"code": 308, "name": "Permanent Redirect", "category": "重定向", "description": "永久重定向。资源已被永久移动到新 URI"},
        
        # 4xx: 客户端错误
        {"code": 400, "name": "Bad Request", "category": "客户端错误", "description": "客户端请求的语法错误，服务器无法理解"},
        {"code": 401, "name": "Unauthorized", "category": "客户端错误", "description": "请求要求用户的身份认证"},
        {"code": 402, "name": "Payment Required", "category": "客户端错误", "description": "保留，将来使用"},
        {"code": 403, "name": "Forbidden", "category": "客户端错误", "description": "服务器理解请求客户端的请求，但是拒绝执行此请求"},
        {"code": 404, "name": "Not Found", "category": "客户端错误", "description": "服务器无法根据客户端的请求找到资源"},
        {"code": 405, "name": "Method Not Allowed", "category": "客户端错误", "description": "客户端请求中的方法被禁止"},
        {"code": 406, "name": "Not Acceptable", "category": "客户端错误", "description": "服务器无法根据客户端请求的内容特性完成请求"},
        {"code": 407, "name": "Proxy Authentication Required", "category": "客户端错误", "description": "请求要求代理的身份认证"},
        {"code": 408, "name": "Request Timeout", "category": "客户端错误", "description": "服务器等待客户端发送的请求时间过长，超时"},
        {"code": 409, "name": "Conflict", "category": "客户端错误", "description": "服务器处理请求时发生了冲突"},
        {"code": 410, "name": "Gone", "category": "客户端错误", "description": "客户端请求的资源已经不存在"},
        {"code": 411, "name": "Length Required", "category": "客户端错误", "description": "服务器无法处理客户端发送的不带 Content-Length 的请求信息"},
        {"code": 412, "name": "Precondition Failed", "category": "客户端错误", "description": "客户端请求信息的先决条件错误"},
        {"code": 413, "name": "Payload Too Large", "category": "客户端错误", "description": "由于请求的实体过大，服务器无法处理，因此拒绝请求"},
        {"code": 414, "name": "URI Too Long", "category": "客户端错误", "description": "请求的 URI 过长，服务器无法处理"},
        {"code": 415, "name": "Unsupported Media Type", "category": "客户端错误", "description": "服务器无法处理请求附带的媒体格式"},
        {"code": 416, "name": "Range Not Satisfiable", "category": "客户端错误", "description": "客户端请求的范围无效"},
        {"code": 417, "name": "Expectation Failed", "category": "客户端错误", "description": "服务器无法满足 Expect 的请求头信息"},
        {"code": 418, "name": "I'm a teapot", "category": "客户端错误", "description": "愚人节笑话，来自超文本咖啡壶控制协议"},
        {"code": 421, "name": "Misdirected Request", "category": "客户端错误", "description": "请求被指向到无法生成响应的服务器"},
        {"code": 422, "name": "Unprocessable Entity", "category": "客户端错误", "description": "请求格式正确，但是由于含有语义错误，无法响应"},
        {"code": 423, "name": "Locked", "category": "客户端错误", "description": "当前资源被锁定"},
        {"code": 424, "name": "Failed Dependency", "category": "客户端错误", "description": "由于之前的某个请求发生的错误，导致当前请求失败"},
        {"code": 425, "name": "Too Early", "category": "客户端错误", "description": "服务器不愿意冒风险来处理该请求"},
        {"code": 426, "name": "Upgrade Required", "category": "客户端错误", "description": "客户端应切换到 TLS/1.0"},
        {"code": 428, "name": "Precondition Required", "category": "客户端错误", "description": "原始服务器需要有条件的请求"},
        {"code": 429, "name": "Too Many Requests", "category": "客户端错误", "description": "用户在给定的时间内发送了太多的请求"},
        {"code": 431, "name": "Request Header Fields Too Large", "category": "客户端错误", "description": "请求头字段太大，服务器拒绝处理"},
        {"code": 451, "name": "Unavailable For Legal Reasons", "category": "客户端错误", "description": "由于法律原因，服务器无法提供该资源"},
        
        # 5xx: 服务器错误
        {"code": 500, "name": "Internal Server Error", "category": "服务器错误", "description": "服务器内部错误，无法完成请求"},
        {"code": 501, "name": "Not Implemented", "category": "服务器错误", "description": "服务器不支持请求的功能，无法完成请求"},
        {"code": 502, "name": "Bad Gateway", "category": "服务器错误", "description": "作为网关或者代理工作的服务器尝试执行请求时，从远程服务器接收到了一个无效的响应"},
        {"code": 503, "name": "Service Unavailable", "category": "服务器错误", "description": "由于超载或系统维护，服务器暂时的无法处理客户端的请求"},
        {"code": 504, "name": "Gateway Timeout", "category": "服务器错误", "description": "作为网关或者代理工作的服务器，未及时从远端服务器获取请求"},
        {"code": 505, "name": "HTTP Version Not Supported", "category": "服务器错误", "description": "服务器不支持请求的 HTTP 协议的版本，无法完成处理"},
        {"code": 506, "name": "Variant Also Negotiates", "category": "服务器错误", "description": "服务器存在内部配置错误"},
        {"code": 507, "name": "Insufficient Storage", "category": "服务器错误", "description": "服务器无法存储完成请求所必须的内容"},
        {"code": 508, "name": "Loop Detected", "category": "服务器错误", "description": "服务器在处理请求时陷入死循环"},
        {"code": 510, "name": "Not Extended", "category": "服务器错误", "description": "获取资源所需要的策略并没有被满足"},
        {"code": 511, "name": "Network Authentication Required", "category": "服务器错误", "description": "客户端需要进行身份验证才能获得网络访问权限"},
    ]
    
    return status_codes

def print_markdown_table():
    """打印 Markdown 格式的表格"""
    status_codes = generate_status_codes_table()
    
    print("# HTTP 状态码表格")
    print()
    print("| 状态码 | 名称 | 类别 | 描述 |")
    print("|--------|------|------|------|")
    
    for item in status_codes:
        # 限制描述长度，避免表格过宽
        description = item["description"]
        if len(description) > 80:
            description = description[:77] + "..."
        
        print(f"| {item['code']} | {item['name']} | {item['category']} | {description} |")

def print_category_summary():
    """按类别打印摘要"""
    status_codes = generate_status_codes_table()
    
    categories = {}
    for item in status_codes:
        category = item["category"]
        if category not in categories:
            categories[category] = []
        categories[category].append(item)
    
    print("## HTTP 状态码类别摘要")
    print()
    
    for category, items in categories.items():
        print(f"### {category} ({len(items)} 个)")
        print()
        for item in items[:5]:  # 只显示每个类别的前5个
            print(f"- **{item['code']} {item['name']}**: {item['description'][:60]}...")
        if len(items) > 5:
            print(f"- ... 还有 {len(items) - 5} 个")
        print()

def save_to_file(filename="http_status_codes.md"):
    """保存为 Markdown 文件"""
    status_codes = generate_status_codes_table()
    
    with open(filename, "w", encoding="utf-8") as f:
        f.write("# HTTP 状态码完整表格\n\n")
        f.write("| 状态码 | 名称 | 类别 | 描述 |\n")
        f.write("|--------|------|------|------|\n")
        
        for item in status_codes:
            description = item["description"]
            if len(description) > 80:
                description = description[:77] + "..."
            
            f.write(f"| {item['code']} | {item['name']} | {item['category']} | {description} |\n")
        
        f.write("\n## 类别统计\n\n")
        
        categories = {}
        for item in status_codes:
            category = item["category"]
            categories[category] = categories.get(category, 0) + 1
        
        for category, count in categories.items():
            f.write(f"- **{category}**: {count} 个状态码\n")
        
        f.write(f"\n**总计**: {len(status_codes)} 个 HTTP 状态码\n")
    
    print(f"✅ 已保存到 {filename}")

def main():
    """主函数"""
    print("=" * 80)
    print("HTTP 状态码表格生成器")
    print("=" * 80)
    print()
    
    # 打印摘要
    print_category_summary()
    
    # 询问用户是否要查看完整表格
    print("=" * 80)
    choice = input("是否要查看完整的 Markdown 表格？(y/n): ").lower()
    
    if choice == 'y':
        print_markdown_table()
        
        # 询问是否保存到文件
        save_choice = input("是否要保存为 Markdown 文件？(y/n): ").lower()
        if save_choice == 'y':
            save_to_file()
            print("✅ 文件已保存！")
    
    print("\n🎯 完成！")

if __name__ == "__main__":
    main()