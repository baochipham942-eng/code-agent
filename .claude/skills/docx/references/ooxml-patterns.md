# OOXML Patterns Reference

Word DOCX 文件本质是 ZIP 包含 XML。核心文件：`word/document.xml`。

## 基本结构

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <!-- 段落和内容 -->
    <w:sectPr><!-- 节属性 --></w:sectPr>
  </w:body>
</w:document>
```

## 段落 `<w:p>`

```xml
<w:p>
  <w:pPr>
    <w:pStyle w:val="Normal"/>
    <w:jc w:val="center"/>        <!-- 对齐: left/center/right/both -->
    <w:spacing w:before="120" w:after="120"/>
  </w:pPr>
  <w:r>
    <w:t xml:space="preserve">段落文本</w:t>
  </w:r>
</w:p>
```

## 运行 `<w:r>`（文本运行）

```xml
<w:r>
  <w:rPr>
    <w:b/>                        <!-- 粗体 -->
    <w:i/>                        <!-- 斜体 -->
    <w:u w:val="single"/>         <!-- 下划线 -->
    <w:strike/>                   <!-- 删除线 -->
    <w:color w:val="FF0000"/>     <!-- 字体颜色 -->
    <w:sz w:val="24"/>            <!-- 字号（半磅，24=12pt） -->
    <w:rFonts w:ascii="Arial" w:eastAsia="宋体"/>
    <w:highlight w:val="yellow"/> <!-- 高亮 -->
  </w:rPr>
  <w:t xml:space="preserve">带格式的文本</w:t>
</w:r>
```

## 标题样式

```xml
<w:p>
  <w:pPr>
    <w:pStyle w:val="Heading1"/>  <!-- Heading1/Heading2/Heading3 -->
  </w:pPr>
  <w:r>
    <w:t>一级标题</w:t>
  </w:r>
</w:p>
```

## 表格 `<w:tbl>`

```xml
<w:tbl>
  <w:tblPr>
    <w:tblW w:w="5000" w:type="pct"/>  <!-- 表格宽度 -->
    <w:tblBorders>
      <w:top w:val="single" w:sz="4" w:color="000000"/>
      <w:bottom w:val="single" w:sz="4" w:color="000000"/>
      <w:insideH w:val="single" w:sz="4" w:color="000000"/>
      <w:insideV w:val="single" w:sz="4" w:color="000000"/>
    </w:tblBorders>
  </w:tblPr>
  <w:tr>                          <!-- 表格行 -->
    <w:tc>                        <!-- 表格单元格 -->
      <w:tcPr>
        <w:tcW w:w="2500" w:type="pct"/>
        <w:shd w:val="clear" w:color="auto" w:fill="E2EFDA"/>
      </w:tcPr>
      <w:p><w:r><w:t>单元格内容</w:t></w:r></w:p>
    </w:tc>
  </w:tr>
</w:tbl>
```

## 图片 `<w:drawing>`

```xml
<w:r>
  <w:drawing>
    <wp:inline distT="0" distB="0" distL="0" distR="0">
      <wp:extent cx="5486400" cy="3657600"/>  <!-- EMU 单位 -->
      <wp:docPr id="1" name="Picture 1"/>
      <a:graphic>
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
          <pic:pic>
            <pic:blipFill>
              <a:blip r:embed="rId7"/>  <!-- 引用 relationships -->
            </pic:blipFill>
          </pic:pic>
        </a:graphicData>
      </a:graphic>
    </wp:inline>
  </w:drawing>
</w:r>
```

## 超链接 `<w:hyperlink>`

```xml
<w:hyperlink r:id="rId5">
  <w:r>
    <w:rPr>
      <w:rStyle w:val="Hyperlink"/>
      <w:color w:val="0563C1"/>
      <w:u w:val="single"/>
    </w:rPr>
    <w:t>链接文本</w:t>
  </w:r>
</w:hyperlink>
```

## 分页符

```xml
<w:p>
  <w:r>
    <w:br w:type="page"/>
  </w:r>
</w:p>
```

## 页码（页脚中）

```xml
<w:ftr>
  <w:p>
    <w:pPr><w:jc w:val="center"/></w:pPr>
    <w:r>
      <w:fldChar w:fldCharType="begin"/>
    </w:r>
    <w:r>
      <w:instrText xml:space="preserve"> PAGE </w:instrText>
    </w:r>
    <w:r>
      <w:fldChar w:fldCharType="end"/>
    </w:r>
  </w:p>
</w:ftr>
```

## Tracked Changes（修订标记）

### 启用修订追踪

在 `word/settings.xml` 中添加：
```xml
<w:settings>
  <w:trackChanges/>
</w:settings>
```

### 插入修订 `<w:ins>`

```xml
<w:ins w:id="1" w:author="Code Agent" w:date="2026-03-20T10:00:00Z">
  <w:r>
    <w:rPr>
      <w:rFonts w:ascii="Arial"/>
    </w:rPr>
    <w:t xml:space="preserve">新增的文本</w:t>
  </w:r>
</w:ins>
```

### 删除修订 `<w:del>`

```xml
<w:del w:id="2" w:author="Code Agent" w:date="2026-03-20T10:00:00Z">
  <w:r>
    <w:rPr>
      <w:rFonts w:ascii="Arial"/>
    </w:rPr>
    <w:delText xml:space="preserve">被删除的文本</w:delText>
  </w:r>
</w:del>
```

### 建议替换（组合删除 + 插入）

```xml
<!-- 先标记删除 -->
<w:del w:id="3" w:author="Code Agent" w:date="2026-03-20T10:00:00Z">
  <w:r>
    <w:delText xml:space="preserve">旧文本</w:delText>
  </w:r>
</w:del>
<!-- 再标记插入 -->
<w:ins w:id="4" w:author="Code Agent" w:date="2026-03-20T10:00:00Z">
  <w:r>
    <w:t xml:space="preserve">新文本</w:t>
  </w:r>
</w:ins>
```

### People XML（`word/people.xml`）

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"
            xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">
  <w15:person w15:author="Code Agent">
    <w15:presenceInfo w15:providerId="None" w15:userId="code-agent"/>
  </w15:person>
</w15:people>
```

## 常用 EMU 换算

- 1 英寸 = 914400 EMU
- 1 厘米 = 360000 EMU
- 1 磅 = 12700 EMU
- A4 宽度 ≈ 7560945 EMU（21cm）
- A4 高度 ≈ 10692130 EMU（29.7cm）
