# 多参考图生成：vendor / 上限选型一页纸（N-IMAGE-MULTI-REF-PROBE，2026-10-29）

> 结论先行（Owner 规则 10-29：百炼接受 ≥3 图 → 选百炼、上限 3）——**选百炼 qwen-image-2.0-pro，输入上限 3 张，实现单 N-IMAGE-MULTI-REF 只需新增一条 qwen-image-edit 调用路径**。价格对比后 2.0（0.2 元/张）是备选。本文档只读官方文档与仓内代码，未调用任何付费 API。

## ① Vendor 对照表（每格标注 doc-quoted / unverified，URL+日期见②）

| 维度 | 阿里云百炼（DashScope/Model Studio） | OpenAI（经 GPTIMAGE_PROXY 中转） |
|---|---|---|
| 接受多图输入的 model id | `qwen-image-2.0-pro`（快照 -2026-06-22/-04-22/-03-03）、`qwen-image-2.0`（=2026-03-03）【doc-quoted，zh/en API 页】；2.1 系列（2.1-pro/2.1-turbo）在价格页出现【doc-quoted】但**其 API 是否同支持 1-3 图未在所读页面确认**（unverified——工单里的"qwen-image-3.0/2.1"名字未在 API 文档出现，维持 unverified） | 中转发的是 `gpt-image-2`（仓内 `imageGenerationService.ts:66`）。OpenAI 官方参考页写 gpt-image-1 家族 `images` 数组 minItems 1 / **maxItems 16**【doc-quoted，API reference】；**gpt-image-2 的多图上限未在官方页面确认**（unverified；第三方 wrapper 称同为 16） |
| **输入图上限** | **3 张**：「支持传入1-3张图像。」/ "You can provide one to three images."【doc-quoted】 | gpt-image-1：16（官方）；gpt-image-2：unverified |
| 请求体 | `POST …/api/v1/services/aigc/multimodal-generation/generation`，JSON：`model` + `input.messages[0].content[]`（`{"image": url|dataURL}`×N + `{"text": 指令}`，**恰好一个 text**）+ `parameters.n`【doc-quoted】 | `POST /v1/images/edits` multipart：`model`/`prompt`/`image[]`（数组）/`mask`/`n`/`size`【doc-quoted，guide】。**仓内现有代码只 append 单个 `image` 字段**（`imageGenerationService.ts:758`，`form.append('image', …)` 单值）——中转要吃多图需改成 `image[]` 重复字段，中转是否透传数组 **unverified（代码读：仓内无多图请求路径；未实测中转）** |
| 第一张图是否"主体/底图" | **doc silent（语义层）**；文档只定顺序与出图比例：「多图输入时，按照数组顺序定义图像顺序，输出图像的比例以最后一张为准。」/"For multi-image input, the image order is defined by the array sequence. The aspect ratio of the output image is based on the last image."【doc-quoted】——谁是主体由 text 指令表达（官方例句"图1中的女生穿着图2中的黑色裙子"）【doc-quoted】 | 有局部定义："If you provide multiple input images, the mask will be applied to the first image."【doc-quoted】——仅约束 mask，不定义"主体" |
| 输入格式/大小 | JPG/JPEG/PNG/BMP/TIFF/WEBP/GIF（GIF 取首帧）；单张 ≤10MB；建议 384–3072px；接受公网 URL 或 base64 dataURL【doc-quoted】 | guide 示例 PNG；image_url maxLength 20971520（~20MB base64）；"The image to edit and mask must be of the same format and size (less than 50MB)"【doc-quoted】 |
| 区域/端点 | 北京 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1`、新加坡 `.ap-southeast-1.`；legacy `https://dashscope.aliyuncs.com(-intl)`；**key 分区域不通用**【doc-quoted】 | 走 `GPTIMAGE_PROXY_BASE`/`GPTIMAGE_PROXY_KEY` 第三方中转（仓内 `imageGenerationService.ts:219-220`），非官方端点 |
| 单价 | 价格页（help.aliyun.com/zh/model-studio/model-pricing）：**qwen-image-2.0 = 0.2 元/张、qwen-image-2.0-pro = 0.5 元/张**（北京，各限免 100 张；新加坡 0.2569/0.5504）；2.1-pro 0.25、2.1-turbo 0.1（限免 10）；qwen-image-3.0-pro 输入 0.02+输出 0.25(1k)/0.5(2k)。失败不计费、按成功产出张数计费【doc-quoted】 | 官方页未列 gpt-image 价格【doc silent】；仓内估值 ¥0.25/张（pricing.ts 注释：保守估值，待真实账单校正） |

## ② 出处与抓取日期（全部 2026-10-29 抓取）

- 百炼 zh API：https://www.alibabacloud.com/help/zh/model-studio/qwen-image-edit-api
- 百炼 en API：https://www.alibabacloud.com/help/en/model-studio/qwen-image-edit-api
- 百炼价格页：https://help.aliyun.com/zh/model-studio/model-pricing（页面未标更新日期——价格标注为抓取当日快照，标注 doc-quoted 但**上线前应复核**）
- OpenAI guide：https://developers.openai.com/api/docs/guides/image-generation
- OpenAI API reference（edit）：https://developers.openai.com/api/reference/resources/images/methods/edit —— 注意该页称 **gpt-image-1 已于 2026-10-23 下线**（后续名 sunburst/flare，unverified）；仓内用的 `gpt-image-2` 与该页不同名，其多图上限 unverified
- 模型总览页（无价格）：https://www.alibabacloud.com/help/zh/model-studio/models —— 列有 qwen-image-3.0-pro/wan2.7-image-pro（"图像生成"），与工单提到的"qwen-image-3.0/2.1"名字部分对上，但 edit API 文档本身只写 2.0 系列

## ③ 与 `IMAGE_PRICING_CNY` 对比（`src/shared/constants/pricing.ts:209` 附近，grep -n 原文）

现表：`wanx2.1-t2i-turbo 0.14 / wanx2.1-imageedit 0.14 / cogview-4-250304 0.06 / cogview-3-flash 0 / flux 0.10 / gpt-image-2 0.25 / default 0.14`。**缺 qwen-image 全家族**。实现单需加行：

- `qwen-image-2.0`: 0.2（doc-quoted，北京价；新加坡 0.2569 需在实现里按区域选择或取上界）
- `qwen-image-2.0-pro`: 0.5（doc-quoted，同上；新加坡 0.5504）
- （若最终选 2.1 系列再对应加 0.25/0.1——本建议未选它）

## ④ 仓内 key 现状（grep，未打印任何值）

- `DASHSCOPE_API_KEY`：owner 机 `~/.code-agent/.env` 已有（工单背景核实；本机同样从 env 读取）——仓内消费点 `imageGenerationService.ts:173-174`（`getDashscopeApiKey()`：env 优先回落 config 槽）→ **已有 key，选百炼零新增配置**
- `GPTIMAGE_PROXY_BASE/KEY`：`imageGenerationService.ts:219-220`（env 优先回落 config 槽）。中转多图能力：**代码读结论 unverified**——仓内唯一 edits 调用是 `editImageByAnnotation`（`:742`，multipart 只 append 单个 `image` 字段 `:758`），`/v1/images/generations` 分支是 JSON 单 prompt（`:650`）；仓内无任何 `image[]` 数组发送路径，中转是否透传未实测（本单禁止调用）
- `qwen-image-max`/`qwen-image-edit-max` 已在 `providerRegistryBase.ts:748/760` 注册，但**无任何多图请求代码路径**（工单背景核实，本席 grep 确认）——即选百炼也要新增请求组装，只是复用既有 dashscope key/端点常量范式

## ⑤ 建议（Owner 规则应用）

**Vendor：阿里云百炼（DashScope）。Model：`qwen-image-2.0-pro`（doc-quoted 支持多图编辑、出图质量档）。输入上限：3（doc 上限即 3，Owner cap=3）。备选：`qwen-image-2.0`（同 API、0.2 元/张，若 pro 的 0.5 元/张成本敏感）。** OpenAI 侧：官方 16 图上限仅对已下线的 gpt-image-1 成立，gpt-image-2 多图 unverified 且中转透传未验证——不选。

**实现单 N-IMAGE-MULTI-REF 需发送的确切字段**（doc-quoted，来自 zh/en API 页最小例）：

```
POST {dashscope-base}/api/v1/services/aigc/multimodal-generation/generation
Authorization: Bearer $DASHSCOPE_API_KEY
Content-Type: application/json
{
  "model": "qwen-image-2.0-pro",
  "input": {
    "messages": [{
      "role": "user",
      "content": [
        { "image": "<ref1: 公网URL或dataURL>" },
        { "image": "<ref2>" },
        { "image": "<ref3>" },          // 1-3 张；输出比例以最后一张为准（doc-quoted）
        { "text": "<指令，恰好一条；多图语义靠'图1/图2'指代>" }
      ]
    }]
  },
  "parameters": { "n": 1 }              // n 可 1-6
}
```

约束备忘：单张 ≤10MB、384–3072px 建议、恰好一个 text（多 text 报错，doc-quoted）、失败不计费；计费按成功产出张数（pro 0.5 元/张，北京区）。加价行：`IMAGE_PRICING_CNY['qwen-image-2.0-pro']=0.5`（备选 `'qwen-image-2.0'=0.2`）。
