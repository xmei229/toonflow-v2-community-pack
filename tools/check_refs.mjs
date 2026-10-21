// 確定性檢查：畫布上每個圖片、視頻生成節點，到底連了哪些參考輸入。不呼叫模型，不信任 Agent 自報。
// 用法：node check_refs.mjs <畫布.json> [更多畫布.json ...]
// 退出碼：有任何「已有輸出卻沒有圖片參考輸入」的生成節點時為 1，否則 0。
import { readFileSync } from "node:fs";

const GEN = /(image|video)GenerationNode$/;
const REF_SOURCE = /(imageNode|imageGenerationNode|videoNode|videoGenerationNode|audioNode|audioGenerationNode)$/;
let flagged = 0;
let flaggedModes = 0;
const noRefBase = [];

for (const file of process.argv.slice(2)) {
  const canvas = JSON.parse(readFileSync(file, "utf8"));
  const byId = new Map(canvas.nodes.map((n) => [n.id, n]));
  console.log(`\n=== ${file}（節點 ${canvas.nodes.length}，連線 ${(canvas.edges || []).length}）`);
  for (const node of canvas.nodes) {
    if (!GEN.test(node.type)) continue;
    const data = node.data || {};
    const kind = /video/.test(node.type) ? "視頻" : "圖片";
    const inputs = (canvas.edges || [])
      .filter((e) => e.target === node.id)
      .map((e) => byId.get(e.source))
      .filter(Boolean);
    const media = inputs.filter((n) => REF_SOURCE.test(n.type));
    const images = media.filter((n) => /image/.test(n.type));
    const hasOutput = !!(data.outputs && Object.keys(data.outputs).length);
    let model = "";
    try { model = JSON.parse(data.model || "[]").join("/"); } catch { model = String(data.model || ""); }
    let status = "ok";
    // 資產畫布裡的基礎資產首圖本來就沒有參考（它們是錨點本身）；衍生資產與其他畫布則必須有
    const baseAsset = (/资产|資產|assets/i.test(file) || /^(资产|資產)/.test(String(data.label))) && !/衍生|derive/i.test(String(data.label));
    if (baseAsset && kind === "圖片" && !images.length) noRefBase.push(String(data.label));
    if (!images.length && baseAsset) status = "基礎資產首圖，允許無參考（它自己是錨點）";
    else if (!images.length) status = hasOutput ? "⚠ 已生成但沒有任何圖片參考輸入（等同無參考生成）" : "⚠ 尚未生成，且沒有圖片參考輸入";
    if (hasOutput && !images.length && !baseAsset) flagged++;
    // 視頻模式：文生視頻不得用於有已命名角色的畫面；路線 A 需要混合參考，路線 B 需要首幀或首尾幀
    let modeLabel = String(data.mode || "-");
    if (kind === "視頻") {
      let m = data.mode;
      try { m = JSON.parse(data.mode); } catch {}
      if (Array.isArray(m)) modeLabel = "混合參考（多參，路線 A）";
      else if (m === "text") { modeLabel = "文生視頻"; if (!/資產|assets|资产/i.test(file)) { status = "⚠ 文生視頻模式，沒有任何參考綁定，不得用於有已命名角色的畫面"; if (!hasOutput) flagged += 0; flaggedModes++; } }
      else if (["startFrameOptional", "endFrameOptional", "startEndRequired", "singleImage"].includes(m)) modeLabel = `首幀／首尾幀（路線 B）`;
    }
    console.log(`- [${kind}] ${data.label}｜${model}｜模式 ${modeLabel}｜${hasOutput ? "已有輸出" : "無輸出"}`);
    console.log(`    圖片參考 ${images.length}：${images.map((n) => n.data?.label).join("、") || "無"}`);
    const other = media.filter((n) => !/image/.test(n.type));
    if (other.length) console.log(`    其他媒體參考：${other.map((n) => n.data?.label).join("、")}`);
    console.log(`    結論：${status}`);
  }
}
console.log(flagged ? `\n共 ${flagged} 個生成節點已產出卻沒有圖片參考輸入。` : "\n沒有發現「已產出卻無圖片參考」的節點。");
if (flaggedModes) console.log(`共 ${flaggedModes} 個視頻節點為文生視頻模式。`);
// 風格錨點：基礎資產圖最多只能有 1 張沒有任何參考圖（它是風格錨點）；其他都該連入錨點圖
const styleFlag = noRefBase.length > 1;
if (styleFlag) console.log(`
⚠ 風格錨點：有 ${noRefBase.length} 張基礎資產圖沒有任何參考圖（${noRefBase.join("、")}）；允許 1 張作為風格錨點，其餘應連入錨點圖，否則風格容易不一致。`);
process.exit(flagged || flaggedModes || styleFlag ? 1 : 0);
