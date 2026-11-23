// 通过飞书官方 lark-cli（用户身份）把 XML 发布为新的云文档，并回读校验
import { spawnSync } from 'node:child_process';

const TIMEOUT_MS = 180_000;
const COUNTED_TAGS = ['whiteboard', 'table', 'img', 'source'];

// Windows 上 lark-cli 是 .cmd，需要经过 shell；拼进命令的外部输入只有校验过的 token
function lark(args, options) {
  const { stdout, stderr, error } = spawnSync(`lark-cli ${args}`, { shell: true, encoding: 'utf8', timeout: TIMEOUT_MS, ...options });
  if (error) throw new Error(`lark-cli 运行失败：${error.message}`);
  let result = null;
  try { result = JSON.parse(stdout); } catch { /* 输出不是 JSON：命令不存在等 */ }
  if (!result?.ok) throw new Error(`lark-cli 返回失败：\n${(stdout + stderr).trim()}`);
  return result.data;
}

// 父级：my_library（个人文档库）、知识库节点或文件夹的链接 / token
function parentFlag(parent) {
  if (parent === 'my_library') return '--parent-position my_library';
  const token = /\/(?:wiki|drive\/folder)\/(\w+)/.exec(parent)?.[1] ?? parent;
  if (!/^\w+$/.test(token)) throw new Error(`--parent 应为 my_library，或知识库节点、文件夹的链接 / token：${parent}`);
  return `--parent-token ${token}`;
}

const ENTITIES = { '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };

// 正文里的文字片段，去掉空白；画板内容不参与比对
const segments = xml => xml.replace(/<whiteboard[\s\S]*?<\/whiteboard>/g, '<>').split(/<[^>]*>/)
  .map(s => s.replace(/&(?:quot|#39|lt|gt|amp);/g, e => ENTITIES[e]).replace(/\s+/g, ''));

// 飞书遇到不支持的内容会直接丢弃：比对发布前后的文字与图表数量
function missing(sent, received) {
  const text = segments(received).join('');
  const problems = [...new Set(segments(sent))].filter(s => !text.includes(s)).map(s => `文字“${s.slice(0, 40)}”`);
  for (const tag of COUNTED_TAGS) {
    const count = xml => xml.split(new RegExp(`<${tag}[ >/]`)).length - 1;
    if (count(received) < count(sent)) problems.push(`${tag} 应有 ${count(sent)} 个，实际 ${count(received)} 个`);
  }
  return problems;
}

// cwd 是 .md 所在目录，XML 里的本地图片路径相对它；XML 走标准输入，不落临时文件
export function publish(xml, { parent, cwd }) {
  const { document, warnings = [] } = lark(`docs +create --as user --doc-format xml --content - ${parentFlag(parent)}`, { cwd, input: xml });
  const back = lark(`docs +fetch --as user --doc ${document.document_id}`, {});
  return { url: document.url, problems: [...warnings, ...missing(xml, back.document.content)] };
}
