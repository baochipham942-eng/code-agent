// ============================================================================
// Generative UI 域词条（ChartBlock / GenerativeUIBlock / DocumentBlock /
// SpreadsheetBlock）—— zh/en 同文件相邻维护。独立文件避免 zh.ts/en.ts 撞
// max-lines(1000) 门（同 previewWorkspace.ts / sidebar.ts / chatInput.ts 先例）。
// ============================================================================

export const generativeUIZh = {
  generativeUI: {
    // Common actions
    copy: '复制',
    copied: '已复制',
    // ChartBlock
    chart: '图表',
    // GenerativeUIBlock
    generativeUI: '交互组件',
    source: '源码',
    open: '打开',
    loading: '加载中…',
    edit: '编辑',
    exitEdit: '退出编辑',
    editHint: '编辑模式下动效会静止，改完退出即可正常播放。',
    selectHint: '点页面上任意一块，选中它。',
    selectionNoText: '（这一块没有文字）',
    clearSelection: '取消选中',
    textLabel: '文字',
    textNotEditable: '这一块里还有别的内容，点更具体的那一块才能改文字',
    fontSizeLabel: '字号',
    colorLabel: '颜色',
    patchFailed: '这一块的位置对不上了，请重新点选。',
    // DocumentBlock
    document: '文档',
    paragraphUnit: '段',
    wordUnit: '词',
    listItem: '列表项',
    paragraph: '段落',
    rewrite: '重写',
    simplify: '精简',
    restyle: '改格式',
    insertAfter: '后面插入',
    // SpreadsheetBlock
    spreadsheet: '电子表格',
    rowUnit: '行',
    columnUnit: '列',
    selected: '已选',
    columns: '列',
    sum: '合计',
    avg: '均值',
    range: '范围',
    visualize: '可视化',
    pivot: '透视表',
    filterAnalysis: '筛选分析',
    sort: '排序',
    clickToSelect: '点击选中，Cmd+点击多选',
    total: '共',
  },
};

export const generativeUIEn = {
  generativeUI: {
    // Common actions
    copy: 'Copy',
    copied: 'Copied!',
    // ChartBlock
    chart: 'Chart',
    // GenerativeUIBlock
    generativeUI: 'Generative UI',
    source: 'Source',
    open: 'Open',
    loading: 'Loading...',
    edit: 'Edit',
    exitEdit: 'Done',
    editHint: 'Animations pause while editing; they resume once you exit.',
    selectHint: 'Click any part of the page to select it.',
    selectionNoText: '(no text in this element)',
    clearSelection: 'Clear selection',
    textLabel: 'Text',
    textNotEditable: 'This block contains other elements — pick a more specific one to edit its text',
    fontSizeLabel: 'Size',
    colorLabel: 'Color',
    patchFailed: "This block can't be located any more. Please select it again.",
    // DocumentBlock
    document: 'Document',
    paragraphUnit: 'paragraphs',
    wordUnit: 'words',
    listItem: 'List Item',
    paragraph: 'Paragraph',
    rewrite: 'Rewrite',
    simplify: 'Simplify',
    restyle: 'Restyle',
    insertAfter: 'Insert After',
    // SpreadsheetBlock
    spreadsheet: 'Spreadsheet',
    rowUnit: 'rows',
    columnUnit: 'cols',
    selected: 'Selected',
    columns: 'columns',
    sum: 'Sum',
    avg: 'Avg',
    range: 'Range',
    visualize: 'Visualize',
    pivot: 'Pivot Table',
    filterAnalysis: 'Filter',
    sort: 'Sort',
    clickToSelect: 'Click to select, Cmd+click for multi-select',
    total: 'total',
  },
};
