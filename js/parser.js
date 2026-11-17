// 剧情脚本解析器：把官方 task2/scripts/*.xml 转成播放器可执行的节点图
// 两种容器结构都要支持：
//   <Npc npcID sceneID><View src/><Create><ViewEvent><Click><Script .../></Click></ViewEvent></Create></Npc>
//   <NPCFun npcID sceneID><Click><Script .../></Click></NPCFun>
// 注意：label 只在同一个 NPC 作用域内唯一（default / index_xxx 都会重复），
// 所以节点 key 用 "作用域:label:序号"，Goto 解析时先找同作用域再退回全局。

export function decodeXml(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("gb18030").decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }
}

function findHolder(el) {
  let p = el.parentElement;
  while (p) {
    const t = p.tagName;
    if (t === "Npc" || t === "NPCFun") return p;
    p = p.parentElement;
  }
  return null;
}

function findTaskId(el) {
  let p = el.parentElement;
  while (p) {
    if (p.tagName === "Task") return p.getAttribute("id") || "";
    p = p.parentElement;
  }
  return "";
}


// 剧本里的台词常写成：
//   <![CDATA[{name}]]>
//   ，你就是那个……
// textContent 会把源码缩进和换行一起吃进来，替换 {name} 之后就变成「名字 换行 空格 逗号」。
// 这里只清理「行首尾空白 + 换行」，正文里本来就有的空格保持不动。
function cleanText(s) {
  return String(s || "")
    .replace(/[ \t]*\r?\n[ \t]*/g, "")
    .replace(/\u00a0/g, " ")
    .trim();
}

export function parseStory(text) {
  /* 官方脚本里混进了 XML 1.0 不允许的控制字符（642 章的 \x02、529 章的 \x06），
   * DOMParser 会直接抛 parsererror，整章载入失败。这里先把它们剔掉再解析。
   * 只去掉 0x00-0x08 / 0x0B / 0x0C / 0x0E-0x1F，制表、换行、回车保留。 */
  const clean = String(text).replace(/^\uFEFF/, "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  const doc = new DOMParser().parseFromString(clean, "application/xml");
  const perr = doc.querySelector("parsererror");
  if (perr) throw new Error("XML 解析失败: " + perr.textContent.slice(0, 200));

  const storyEl = doc.querySelector("Story");
  const taskEl = doc.querySelector("Task");
  const allTasks = [...storyEl.children].filter((e) => e.tagName === "Task");
  if (!storyEl || !taskEl) throw new Error("不是剧情脚本：缺少 Story/Task 节点");

  const taskList = allTasks.map((t) => ({
    id: t.getAttribute("id") || "",
    label: t.getAttribute("label") || "",
  }));

  const npcEls = [...storyEl.querySelectorAll("Npc, NPCFun")];
  const npcs = npcEls.map((n) => ({
    npcID: n.getAttribute("npcID") || "",
    sceneID: n.getAttribute("sceneID") || "",
    // 场景版本：同一个 sceneID 可能有新旧几版（商店街改版、植物园烧毁……），
    // 剧本用 <Npc ver="2"> 指定。缺省按客户端 CommonTaskScript 的写法算 1，0 表示"最新版"。
    sceneVer: n.getAttribute("ver") == null ? 1 : Number(n.getAttribute("ver")) || 0,
    name: n.getAttribute("name") || n.getAttribute("label") || "",
    view: n.querySelector("View")?.getAttribute("src") || "",
    tag: n.tagName,
  }));

  const scopeOf = new Map();
  let scopeSeq = 0;
  // 先把每个 Npc/NPCFun 的作用域编好，后面算 state 要按作用域走
  for (const n of npcEls) if (!scopeOf.has(n)) scopeOf.set(n, ++scopeSeq);

  const nodes = new Map(); // key -> node
  const order = []; // key 顺序
  const byLabel = new Map(); // label -> [key]
  const scriptPos = new Map(); // key -> 文档序号（含 Click）

  // 文档序：Script 和 Click 一起排，Goto 常指向 Click（场景命令/任务回调），
  // 这类 label 不是节点，但可以据此定位「它之后的下一个 Script」。
  const allEls = [...storyEl.querySelectorAll("Script, Click")];
  const docIndex = new Map();
  allEls.forEach((el, i) => docIndex.set(el, i));
  const labelPos = new Map(); // label -> 最小文档序号
  for (const el of allEls) {
    const lb = el.getAttribute("label");
    if (!lb) continue;
    const i = docIndex.get(el);
    if (!labelPos.has(lb) || i < labelPos.get(lb)) labelPos.set(lb, i);
  }

  /* NPC 状态：剧本在每个 Script 后面挂一条
   *   <Click ... params="state_0_3678_677300_0"/>
   * 客户端据此把该 NPC 切到对应姿态（大卡 Swf 的第 N+1 帧）。
   * 按文档顺序推一遍，记下每个 Script 开始时该作用域已经生效的 state。
   * InitNpc_state_* 是初始化指令，不算状态切换。 */
  const stateByScope = new Map();
  const stateOfScript = new Map();
  for (const el of allEls) {
    const holder = findHolder(el);
    const scope = holder ? scopeOf.get(holder) || 0 : 0;
    if (el.tagName === "Script") {
      // 只记"已经出现过 state 指令"的脚本；一段都没出现过的是初始姿态（第 1 帧），
      // 不能当成 state_0（那是第 2 帧）
      if (stateByScope.has(scope)) stateOfScript.set(el, stateByScope.get(scope));
    } else {
      const m = /^state_(\d+)_/.exec(el.getAttribute("params") || "");
      if (m) stateByScope.set(scope, Number(m[1]));
    }
  }

  for (const el of storyEl.querySelectorAll("Script")) {
    const holder = findHolder(el);
    // <finishProcess> 里的 Script 是任务结算后的「完成/失败提示板」，不在剧情流程里：
    // 它没有 Npc/NPCFun 归属，靠 Case/Goto 判条件，正常剧情不会走到。
    // 以前把它们当普通节点，末尾节点找不到 Goto 时会按文档顺序掉进去，
    // 结果在故事结束后连播两张提示卡、然后卡住（376《精灵女王》就是这么卡死的）。
    if (!holder) continue;
    let scope = 0;
    if (holder) {
      if (!scopeOf.has(holder)) scopeOf.set(holder, ++scopeSeq);
      scope = scopeOf.get(holder);
    }

    const label = el.getAttribute("label") || "default";
    const type = el.getAttribute("type") || "dialog";
    const key = `${scope}:${label}:${order.length}`;

    const node = {
      key,
      scope,
      label,
      type,
      taskId: findTaskId(el),
      npc: holder
        ? {
            npcID: holder.getAttribute("npcID") || "",
            sceneID: holder.getAttribute("sceneID") || "",
            sceneVer: holder.getAttribute("ver") == null ? 1 : Number(holder.getAttribute("ver")) || 0,
            view: holder.querySelector("View")?.getAttribute("src") || "",
            layer: holder.querySelector("View")?.getAttribute("atLayerID") || "1",
          }
        : { npcID: "", sceneID: "", sceneVer: 1, view: "", layer: "1" },
      src: el.getAttribute("src") || "",
      // 帧号按客户端 MagicNPC.onSceneEvent 来：InitNpc 是 gotoAndStop(1)，
      // state_N 是 gotoAndStop(N + 2)。之前按 N+1 算，整组 NPC 的姿态会永远慢一段。
      state: stateOfScript.has(el) ? stateOfScript.get(el) + 2 : 1,
      pages: [],
      defaultGoto: null,
      next: null,
    };

    if (type === "asWindow") {
      node.defaultGoto = el.querySelector("Default > Goto")?.getAttribute("value") || null;
    } else {
      const pageEls = el.querySelectorAll("Page");
      for (const page of pageEls) {
        node.pages.push({
          dialogs: [...page.querySelectorAll("Dialog")].map((d) => ({
            npcID: d.getAttribute("npcID") || "",
            name: d.getAttribute("npcName") || "",
            text: cleanText(d.textContent),
          })),
          buttons: [...page.querySelectorAll("Button")].map((b) => ({
            label: (b.getAttribute("label") || "").trim(),
            goto: b.querySelector("Goto")?.getAttribute("value") || null,
          })),
        });
      }
      if (!node.pages.length) {
        const dialogs = [...el.querySelectorAll("Dialog")].map((d) => ({
          npcID: d.getAttribute("npcID") || "",
          name: d.getAttribute("npcName") || "",
          text: cleanText(d.textContent),
        }));
        if (dialogs.length) node.pages.push({ dialogs, buttons: [] });
      }
    }

    nodes.set(key, node);
    order.push(key);
    scriptPos.set(key, docIndex.get(el) ?? -1);
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(key);
  }

  for (let i = 0; i < order.length - 1; i++) nodes.get(order[i]).next = order[i + 1];

  // Goto 解析：同作用域优先，否则退回全局第一个同名 label
  function resolve(fromKey, label) {
    if (!label) return null;
    const direct = nodes.get(label);
    if (direct) return direct.key;

    const cands = byLabel.get(label);
    if (cands && cands.length) {
      const fromScope = nodes.get(fromKey)?.scope;
      const same = cands.find((k) => nodes.get(k).scope === fromScope);
      return same || cands[0];
    }

    // label 指向的不是 Script（多半是 Click：场景命令 / 任务回调），
    // 按文档顺序取它之后的第一个 Script，这样剧情不会在这里断掉。
    const pos = labelPos.get(label);
    if (pos != null) {
      let best = null;
      for (const k of order) {
        const p = scriptPos.get(k);
        if (p != null && p > pos) {
          best = k;
          break;
        }
      }
      if (best) return best;
    }
    return null;
  }

  // 每个小任务的起始节点（第一个属于它的 Script）
  const taskStart = new Map();
  for (const k of order) {
    const n = nodes.get(k);
    if (n?.taskId && !taskStart.has(n.taskId)) taskStart.set(n.taskId, k);
  }

  return {
    id: storyEl.getAttribute("id") || "",
    label: storyEl.getAttribute("label") || "",
    taskId: taskEl.getAttribute("id") || "",
    taskLabel: taskEl.getAttribute("label") || "",
    tasks: taskList.length ? taskList : [{ id: taskEl.getAttribute("id") || "", label: taskEl.getAttribute("label") || "" }],
    taskStart,
    npcs,
    // 场景 + 版本，写成 "240.2" 这种形式给下载清单用
    scenes: [
      ...new Set(npcs.filter((n) => n.sceneID).map((n) => `${n.sceneID}.${n.sceneVer ?? 1}`)),
    ],
    nodes,
    order,
    byLabel,
    resolve,
    start: order[0],
  };
}
