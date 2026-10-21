# 來源標示

## 上游

- 專案：Toonflow-app（https://github.com/HBAI-Ltd/Toonflow-app）
- 授權：MIT License，Copyright (c) 2026 HBAI-Ltd（全文見 `LICENSE.upstream-MIT.txt`）
- 取用版本：v2.0.6 與 v2.0.7 的內建技能 `v118workflow`（1.1.0）、`workflow`（2.7.0）

## 本倉庫修改了哪些上游檔案

`skills-patched/` 與 `dist/*.zip` 內的下列檔案是上游技能文字的修改版，每處修改都以 HTML 註解「本地定制」標出：

- `v118workflow/SKILL.md`
- `v118workflow/references/baseAssets.md`
- `v118workflow/references/storyboardPanel.md`
- `v118workflow/references/storyboardImages.md`
- `v118workflow/references/videoProduction.md`
- `v118workflow/references/knowledge/videoPromptCraft.md`
- `workflow/SKILL.md`

`dist/*.zip` 為方便本地安裝，另含上游技能的其餘未修改檔案，並改名為 `v118workflowPlus`、`workflowPlus`（`SKILL.md` 的 `name`、`description`、`displayName` 已調整）。

## 原創部分

`providers/falAi.ts`、`providers/openRouter.ts`、`tools/check_refs.mjs` 為本倉庫撰寫；供應商檔遵循 Toonflow 的自訂媒體供應商介面。其中 OpenRouter 供應商最初由 Toonflow 內建的 AI 接入助手依接口資料生成，後經人工審閱與修改。

## 聲明

本倉庫為社群專案，與 HBAI-Ltd 無隸屬或背書關係。「Toonflow」及相關名稱屬其各自權利人；本倉庫只以描述相容對象的方式使用。第三方服務（Fal、OpenRouter、APIMart 等）的名稱與介面屬各自權利人，本倉庫不含其文件內容的複製。
