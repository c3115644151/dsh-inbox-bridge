import fs from "node:fs";

function edit(file, pairs) {
  let text = fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  for (const [from, to] of pairs) {
    const count = text.split(from).length - 1;
    if (count !== 1) throw new Error(`${file}: expected 1 match, got ${count} for:\n${from.slice(0, 120)}`);
    text = text.replace(from, to);
  }
  fs.writeFileSync(file, text, "utf8");
  console.log(`updated ${file}`);
}

const DESCRIPTION_EN =
  "GitHub inbox for DeepSeek Harness: reads CI runs, pull requests and issues on an interval, queues one notice for the next turn, and can wake one idle session.";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.version = "2.0.3";
pkg.displayName = "GitHub inbox";
pkg.description = DESCRIPTION_EN;
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n", "utf8");
console.log("updated package.json");

const zh = {
  meta: {
    title: "GitHub 收件箱",
    description:
      "每 45 秒读一次 GitHub 的 CI、PR 检查和 issue，把需要处理的变化排进下一次对话开头；默认只排队，wakeup 模式会唤醒一个空闲会话。条目分 pending / delivered / done 三态，同一事件不会无限重复。",
    detail: "docs/DETAIL.zh.md",
  },
};
const en = {
  meta: {
    title: "GitHub inbox",
    description:
      "Reads GitHub CI runs, pull requests and issues every 45 seconds, queues one notice for the next turn, and can wake one idle session in wakeup mode. Items move through pending / delivered / done so the same event is not repeated forever.",
    detail: "docs/DETAIL.md",
  },
};
fs.writeFileSync("locale/zh.json", JSON.stringify(zh, null, 2) + "\n", "utf8");
fs.writeFileSync("locale/en.json", JSON.stringify(en, null, 2) + "\n", "utf8");
console.log("updated locale files");

edit("README.md", [
  [
    `把外部事件变成下一次对话回合开头的一条通知。

DeepSeek Harness 插件：按固定间隔轮询一个外部来源（默认 GitHub），把新事件注入智能体的下一回合开头，并维护 \`pending\` / \`delivered\` / \`done\` 三态，使同一条事件不会被反复推送。它从 [Noema](https://github.com/Noema-Harness/noema-agent) 工作区抽出，本身不依赖 Noema。

- 仓库：<https://github.com/c3115644151/dsh-inbox-bridge>
- 版本：1.5.1，MIT`,
    `把 GitHub 的 CI、PR 与 issue 变成下一次对话开头的一条通知。

DeepSeek Harness 插件：每 45 秒读一次 GitHub 的 CI 运行、PR 检查和 issue，把需要处理的变化按 \`pending\` / \`delivered\` / \`done\` 三态管理，投递到对话回合边界；默认只排队，\`wakeup\` 模式下会唤醒一个空闲会话。它从 [Noema](https://github.com/Noema-Harness/noema-agent) 工作区抽出，本身不依赖 Noema。

- 仓库：<https://github.com/c3115644151/dsh-inbox-bridge>
- 版本：2.0.3，MIT`,
  ],
  [
    "安装后插件条目会出现在 `cordis.patch.yml` 的 `inbox-bridge` 行；改代码或改配置后都需要重启 DSH。",
    "安装后插件条目会出现在 `cordis.patch.yml` 的 `inbox-bridge` 行。插件代码与配置的改动由 DSH 的 profile 重组接管：在 Plugin Manager 里停用再启用一次该插件即可生效，不需要重启进程。",
  ],
  ["45 个用例覆盖纯逻辑", "47 个用例覆盖纯逻辑"],
  [
    "- **通知正文是中文**：`label` 可改标题，内置提示语固定中文。",
    "- **通知正文是中文**：`label` 可改标题，内置提示语固定中文。\n- **内置来源只有 GitHub**：CI、PR、issue 三类事件来自 `gh`；`poll` / `ack` 可以换成自定义脚本，但本包不内置邮件、本地命令等来源。",
  ],
]);

edit("README.en.md", [
  [
    `Turns external events into one notice at the start of the next conversation turn.

A DeepSeek Harness plugin: it polls an external source (GitHub by default) on an interval, injects new events at the start of the agent's next turn, and keeps \`pending\` / \`delivered\` / \`done\` state so the same event is not pushed over and over. It was extracted from the [Noema](https://github.com/Noema-Harness/noema-agent) workspace; nothing in it is Noema-specific.

- Repository: <https://github.com/c3115644151/dsh-inbox-bridge>
- Version: 1.5.1, MIT`,
    `Turns GitHub CI, pull requests and issues into one notice at the start of the next conversation turn.

A DeepSeek Harness plugin: every 45 seconds it reads GitHub CI runs, pull request checks and issues, keeps each change in \`pending\` / \`delivered\` / \`done\` state, and delivers it at a turn boundary. It queues by default; \`wakeup\` mode also opens one idle session. It was extracted from the [Noema](https://github.com/Noema-Harness/noema-agent) workspace; nothing in it is Noema-specific.

- Repository: <https://github.com/c3115644151/dsh-inbox-bridge>
- Version: 2.0.3, MIT`,
  ],
  [
    "After install, the plugin entry lives in the `inbox-bridge` row of `cordis.patch.yml`. Restart DSH after changing the plugin's code or config.",
    "After install, the plugin entry lives in the `inbox-bridge` row of `cordis.patch.yml`. Changes to the plugin's code or config are picked up by a DSH profile recomposition: disable and re-enable the plugin in Plugin Manager; no process restart is needed.",
  ],
  ["The 45 tests cover the pure logic", "The 47 tests cover the pure logic"],
  [
    "- **The notice body is Chinese** — `label` changes the title, but the built-in guidance text is fixed Chinese.",
    "- **The notice body is Chinese** — `label` changes the title, but the built-in guidance text is fixed Chinese.\n- **The built-in source is GitHub only** — CI, pull request and issue events come from `gh`. `poll` / `ack` can point at a custom script, but this package ships no mail or local-command source.",
  ],
]);

const changelog = fs.readFileSync("CHANGELOG.md", "utf8");
const entry =
  "## 2.0.3\n\n- 统一对外描述：插件只读 GitHub（CI、PR、issue），不再宣称“任意外部来源 / 邮件 / 本地命令”；标题、描述、README 与市场索引使用同一句话，版本与用例数同步。\n\n";
const marker = "## 2.0.2";
if (!changelog.includes(marker)) throw new Error("CHANGELOG: 2.0.2 anchor missing");
fs.writeFileSync("CHANGELOG.md", changelog.replace(marker, entry + marker), "utf8");
console.log("updated CHANGELOG.md");
