# Toonflow v2 社群客製包

> **不熟悉命令列或 GitHub？請先看《安裝說明（白話版）.md》**，用按鈕順序一步一步寫的版本。

> ## 先看這個：兩種檔案要裝在兩個不同的頁面
>
> | 檔案 | 裝在哪裡 | 怎麼裝 |
> |---|---|---|
> | `providers/falAi.ts`、`providers/openRouter.ts`（**供應商**） | **設定 → 模型 → 媒體模型** | 新增自訂供應商 → 「文件導入」（或「貼上代碼」） |
> | `dist/v118workflowPlus.zip`、`dist/workflowPlus.zip`（**技能**） | **設定 → 外掛市集 → 已安裝** | 安裝插件（`.zip` 會自動判成技能） |
>
> - **外掛市集的「安裝插件」按鈕不收 `.ts`**：供應商不是外掛市集的類型，選 `falAi.ts` 只會得到錯誤訊息。
> - **供應商檔不會順便裝技能，技能壓縮檔也不含供應商**，兩邊各裝各的。
> - **Docker 版**：外掛市集的技能安裝只接受「本機」請求，瀏覽器的請求在容器看來不是本機，會被拒絕（我們實測回應 403）；改用下方「技能（Docker 版）」複製檔案。供應商頁在 Docker 是否有同樣限制沒有驗證。
> - 不需要註冊 TF-Router：以上兩種安裝都不需要；只有外掛市集的「發現插件」分頁要它的 API Key。

給 [Toonflow](https://github.com/HBAI-Ltd/Toonflow-app) v2 的社群客製：兩個媒體供應商（Fal AI、OpenRouter）與 `v118workflow`、`workflow` 兩個內建技能的修補版。**非官方，也不是 HBAI-Ltd 發佈。** 沒有任何金鑰，金鑰自己填。

- 適用版本：Toonflow 2.0.6、2.0.7。
- 驗證程度：在 Docker 版驗證過載入；桌面版沒有測。Fal 供應商只有「H3 Max Turbo 圖生視頻」被真實呼叫驗證過，其餘端點（含 Seedance、Wan）依官方規格寫成並以模擬回應測試，未實測；技能修補尚未做過第三方實測。

## 裡面有什麼

| 路徑 | 內容 |
|---|---|
| `dist/v118workflowPlus.zip` | 可本地安裝的技能：`v118workflow` 修補版，新名稱，與原技能並存 |
| `dist/workflowPlus.zip` | 可本地安裝的技能：`workflow`（主流程）加一致性鐵則，**另加 Wan 3.0 與 H3 的分段提示詞模板（A9.3、A9.4）**；使用者指定 Wan 或 H3 時解除 Seedance 路由鎖存。新名稱，與原技能並存 |
| `providers/falAi.ts` | Fal AI：H3、H3 Max、H3 Max Turbo（圖生與參考生視頻）、Wan 3.0（圖生、文生、參考生）、**Seedance 2.0 與 2.5（圖生、文生、參考生）**、Nano Banana Pro、GPT Image 2，共 17 個模型 |
| `providers/openRouter.ts` | OpenRouter **媒體**供應商：Qwen、Gemini、GPT 圖像；H3、H3 Max、Wan 3.0 圖生視頻，共 8 個模型。**不含文字模型** |
| `skills-patched/` | 修補過的檔案原文（便於看差異與手動合併） |
| `tools/check_refs.mjs` | 選用，需要 Node：讀畫布 JSON，列出每個生成節點實際連了哪些參考、視頻模式 |

## 技能修補做了什麼

1. **一致性鐵則**（路線 A、B 與所有模型通用）：參考圖先於生成、禁止無參考生成、生成前輸出核對表並回讀連線、人物用規範名稱加位置、聲音固定、承接上一單元、驗收不降級、路線由使用者決定。
2. **聲音檔案**：有台詞的角色在資產階段寫一段聲音描述，之後逐字複用。
3. **路線 A（以段）與路線 B（以鏡）**：兩條都可用，路線 A 附五項檢查（模式必須是混合參考、端點支援混合參考、角色與場景參考覆蓋、引用寫法、時間碼）。
4. **場記命名與剪輯表**：`S2-04-T1`；剪輯表供剪輯軟體使用。
5. **H3 與 Wan 3.0 提示詞模板**。
6. **風格錨點**（鐵則 10）：資產階段先寫一段共同風格規格，逐字放進每個資產提示詞；第一張定稿的角色板當錨點圖，連入後續場景與道具。`check_refs.mjs` 會警告「多張基礎資產圖沒有參考圖」。
7. 提示詞內的參考引用，對 Wan 與 H3 的參考生視頻寫 `Image N`：Toonflow 的視頻節點會把提示詞原樣交給供應商，不會替換 `{{ref N}}`。

## 安裝

### 技能（桌面版）
設定 → 外掛市集 → 已安裝 → 安裝插件，選 `dist/*.zip`。不需要 TF-Router 帳號。安裝後在對話框按書本圖示，或輸入 `/skill:v118workflowPlus`。

### 技能（Docker 版）
Toonflow 的技能安裝介面只接受「本機」請求；在 Docker 裡，瀏覽器的請求在容器看來不是本機，會被拒絕（`請在桌面端或服務器本機安裝技能`，我們實測過回應 403）。改為把檔案複製進容器的 `/app/data/skills/`：

```bash
docker cp skills-patched/v118workflow/. <容器名>:/app/data/skills/v118workflow/
```

這會**覆蓋同名內建技能的檔案**，先備份。Toonflow 只在 `skills/initialized` 標記檔不存在時複製一次內建技能，升級不會覆蓋，但也不會自動跟上新版技能。

### 供應商

> **提醒：`openRouter.ts` 是「媒體」供應商（生圖、生影片），不是文字模型。** 想用 OpenRouter 當助手的「大腦」來聊天，不需要這個檔案，到「設定 → 文字模型」填網址 `https://openrouter.ai/api/v1`、協定 `openai-completions` 與 API Key 即可。文字與媒體兩邊的 API Key 各自保存，同一把 OpenRouter 金鑰要在兩處各貼一次。
設定 → 模型 → 媒體模型 → 新增自訂供應商 → 「文件導入」，選 `providers/falAi.ts` 或 `openRouter.ts` → 自己填 API Key → 啟用要用的模型。先用最便宜的設定（480p、5 秒）試一次，載入成功不代表呼叫成功。Docker 版的導入是否受同樣的本機限制，我沒有驗證；若被拒絕，把檔案複製到容器的 `/app/data/providers/`。

## 使用

- 開場訊息寫明技能與路線，例如：「用 v118workflowPlus，視頻走路線 A」。
- 路線 A 的視頻節點，模式要選「混合參考」，角色圖與場景圖連到節點的參考輸入。
- 每個新對話都要手動確認聊天模型。

## 已知限制

- 技能規則是寫給 Agent 看的，不是程式強制；Agent 的自我回報不可信，請自己看畫布，或用 `check_refs.mjs` 核對。
- 嘴型：Wan 3.0 的嘴型未實測；H3 實測對白內容正確、嘴型沒有對上。
- 價格欄位的單位未驗證，費用以各平台帳單為準。
- 升級 Toonflow 後，內建技能若有新版，這裡的修補要自己重新合併。

## 授權與來源

MIT。`skills-patched/` 與 `dist/` 內的技能檔是 Toonflow 內建技能的修改版，上游為 MIT（Copyright (c) 2026 HBAI-Ltd），授權全文見 `LICENSE.upstream-MIT.txt`，來源說明見 `NOTICE.md`。供應商檔依 Toonflow 的供應商介面寫成。
