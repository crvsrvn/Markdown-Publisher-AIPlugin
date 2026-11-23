// Markdown → 飞书云文档 XML（lark-cli docs +create 的 xml 格式）：复用 HTML 导出的解析结果，逐块换成飞书标签
import { existsSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { createMd } from './md.mjs';
import { csvRow, heatLabels, heatLevel } from './plugins/heatmap.mjs';
import { isVideo } from './plugins/media.mjs';
import { preparePlantUml, splitFrontMatter } from './render.mjs';
import { KINDS, escapeHtml as esc, parseFenceInfo } from './util.mjs';

const COLORS = { info: 'blue', tip: 'green', ok: 'green', warn: 'orange', danger: 'red', key: 'purple', muted: 'gray' };
const EMOJIS = { info: '📝', tip: '💡', ok: '✅', warn: '❗', danger: '🚫', key: '📌', muted: '💬' };
const HEAT_COLORS = ['light-yellow', 'light-orange', 'yellow', 'orange', 'red'];
const CODE_LANGS = { cs: 'csharp', ps1: 'powershell', sh: 'bash', py: 'python', js: 'javascript', ts: 'typescript', jsonl: 'json', text: 'plaintext', '': 'plaintext' };
// 高亮块里不能放的块
const NOT_IN_CALLOUT = /<(table|img|pre|hr|grid|whiteboard|blockquote|callout|figure|source)\b/;
const PAGE_WIDTH = 820;
const MIN_COL_WIDTH = 80;
const MAX_GRID_COLUMNS = 3;

// 扁平 token → 树
function tree(tokens) {
  const root = { children: [] };
  const stack = [root];
  for (const token of tokens) {
    if (token.nesting < 0) { stack.pop(); continue; }
    const node = { type: token.type.replace(/_open$/, ''), token, children: [] };
    stack.at(-1).children.push(node);
    if (token.nesting > 0) stack.push(node);
  }
  return root.children;
}

const gray = xml => `<span text-color="gray">${xml}</span>`;
const bold = xml => `<b>${xml}</b>`;
const blocks = (nodes, c) => nodes.map(n => block(n, c)).join('');

function block(node, c) {
  const render = BLOCKS[node.type];
  if (!render) throw new Error(`飞书导出不支持的内容：${node.type}`);
  return render(node, c);
}

// ---------- 行内 ----------

const wrap = (open, close = open) => (n, c) => `<${open}>${inlines(n.children, c)}</${close}>`;

const INLINES = {
  text: n => esc(n.token.content),
  softbreak: () => ' ',
  hardbreak: () => '<br/>',
  code_inline: n => `<code>${esc(n.token.content)}</code>`,
  html_inline: () => '',                    // 只有标题的序号与锚点，飞书自动编号
  strong: wrap('b'),
  em: wrap('em'),
  s: wrap('del'),
  mark: wrap('span background-color="light-yellow"', 'span'),
  footnote_ref: n => `[${n.token.meta.id + 1}]`,
  footnote_anchor: () => '',
  link(n, c) {
    const href = n.token.attrGet('href') ?? '';
    const text = inlines(n.children, c);
    if (/^(https?|mailto):/i.test(href)) return `<a href="${esc(href)}">${text}</a>`;
    c.warnings.add(href.startsWith('#') ? '页内链接只保留文字，不能点击' : `相对链接只保留文字：${decodeURIComponent(href)}`);
    return text;
  },
  image(n, c) {
    c.media.push(mediaBlock(n.token, c));
    return '';
  },
  hs_dir(n, c) {
    const { name, label } = n.token.meta;
    if (name === 'icon') { c.warnings.add('行内图标不导出'); return ''; }
    const text = inlines(n.children, c);
    if (name === 'kbd') return `<code>${text}</code>`;
    if (name === 'k') return gray(text);
    const kind = KINDS.includes(name) ? name : c.front.marks?.[label]?.kind;
    if (!kind) throw new Error(`图例记号 :m[${label}] 没有在文件头 marks 里声明`);
    return `<span text-color="${COLORS[kind]}">${text}</span>`;
  },
};

function inlines(nodes, c) {
  return nodes.map(n => {
    const render = INLINES[n.type];
    if (!render) throw new Error(`飞书导出不支持的行内内容：${n.type}`);
    return render(n, c);
  }).join('');
}

const inlineToken = (token, c) => inlines(tree(token.children ?? []), c);
const inlineText = (text, c) => inlineToken(c.md.parseInline(text, c.env)[0], c);
const plainText = token => token.children.filter(t => t.type === 'text' || t.type === 'code_inline').map(t => t.content).join('');
const firstInline = node => node.children.find(n => n.type === 'inline');

// 飞书的图片与附件是独立的块：行内遇到时先存起来，跟在所在段落后面
function flushMedia(c) {
  return c.media.splice(0).join('');
}

function mediaBlock(token, c) {
  const src = token.attrGet('src') ?? '';
  const caption = token.attrGet('title') || token.content;
  const remote = /^https?:/i.test(src);
  if (remote && isVideo(src)) return `<p><a href="${esc(src)}">${esc(caption || src)}</a></p>`;
  const captionAttr = caption ? ` caption="${esc(caption)}"` : '';
  if (remote) return `<img href="${esc(src)}"${captionAttr}/>`;
  const file = resolve(c.dir, decodeURIComponent(src));
  if (!existsSync(file)) throw new Error(`图片或视频文件不存在：${src}（${file}）`);
  // lark-cli 只接受当前目录内的文件，发布时以 .md 所在目录为当前目录
  const path = relative(c.dir, file).replace(/\\/g, '/');
  if (/^(\.\.\/|[a-z]:)/i.test(path)) throw new Error(`飞书导出只支持 .md 所在目录内的图片与视频：${src}`);
  return isVideo(src)
    ? `<figure view-type="Preview"><source path="@./${esc(path)}" name="${esc(basename(path))}"/></figure>`
    : `<img path="@./${esc(path)}"${captionAttr}/>`;
}

// ---------- 块 ----------

function paragraph(node, c) {
  const inline = firstInline(node);
  let xml = inline ? inlineToken(inline.token, c) : '';
  const media = flushMedia(c);
  if (/\b(hs-muted|hs-meta|src)\b/.test(node.token.attrGet('class') ?? '')) xml = gray(xml);
  return (xml.trim() ? `<p>${xml}</p>` : '') + media;
}

function heading(node, c) {
  const { token } = node;
  const inline = firstInline(node).token;
  const level = +token.tag[1];
  if (level === 1) return '';                // 一级标题就是云文档标题
  const numbered = inline.children[0]?.type === 'html_inline' && inline.children[0].content.includes('hs-num');
  const custom = token.meta?.attrs?.n;       // 强制序号无法交给飞书自动编号，直接写进文字
  const text = (custom ? `${esc(custom)} ` : '') + inlineToken(inline, c);
  return `<h${level - 1}${numbered && !custom ? ' seq="auto"' : ''}>${text}</h${level - 1}>${flushMedia(c)}`;
}

// 拆成顶层标签
function topLevel(xml) {
  const parts = [];
  let depth = 0, start = 0;
  for (const m of xml.matchAll(/<(\/?)[\w-]+[^>]*?(\/?)>/g)) {
    if (m[1]) depth--;
    else if (!m[2]) depth++;
    if (depth > 0) continue;
    const end = m.index + m[0].length;
    parts.push(xml.slice(start, end));
    start = end;
  }
  return parts;
}

// 飞书的列表项不能放段落：第一个块之前的段落用换行连接，之后的段落改成子列表
function listItem(item, c) {
  let xml = '', afterBlock = false;
  for (const part of topLevel(blocks(item.children, c))) {
    const text = /^<p(?: [^>]*)?>([\s\S]*)<\/p>$/.exec(part)?.[1];
    if (text === undefined) { xml += part; afterBlock = true; }
    else if (afterBlock) xml += `<ul><li>${text}</li></ul>`;
    else xml += (xml && '<br/>') + text;
  }
  return xml;
}

function list(node, c) {
  const ordered = node.type === 'ordered_list';
  const start = node.token.attrGet('start') ?? 1;
  const items = node.children.map((item, i) => `<li${ordered ? ` seq="${i === 0 ? start : 'auto'}"` : ''}>${listItem(item, c)}</li>`);
  const tag = ordered ? 'ol' : 'ul';
  return `<${tag}>${items.join('')}</${tag}>`;
}

// 高亮块只能放段落与列表：遇到表格、代码等块时断开，放在高亮块之间，保持原有顺序
function callout(node, c) {
  const kind = node.token.meta.callout;
  const [title, ...body] = node.children;
  const parts = [{ inside: true, xml: `<p>${bold(inlineToken(firstInline(title).token, c))}</p>${flushMedia(c)}` }];
  for (const child of body) {
    const xml = block(child, c);
    const inside = !NOT_IN_CALLOUT.test(xml);
    if (inside && parts.at(-1).inside) parts.at(-1).xml += xml;
    else parts.push({ inside, xml });
  }
  const color = COLORS[kind];
  return parts.map(({ inside, xml }) => inside
    ? `<callout emoji="${EMOJIS[kind]}" background-color="light-${color}" border-color="${color}">${xml}</callout>`
    : xml).join('');
}

// 定义列表：“术语：解释”，解释里的其他块跟在后面
function definitions(node, c) {
  let xml = '', term = '';
  for (const child of node.children) {
    if (child.type === 'dt') { term = bold(inlineToken(firstInline(child).token, c)); continue; }
    const [first, ...rest] = child.children;
    const lead = first?.type === 'paragraph';
    const text = lead ? inlineToken(firstInline(first).token, c) : '';
    xml += `<p>${[term, text].filter(Boolean).join('：')}</p>${flushMedia(c)}${blocks(lead ? rest : child.children, c)}`;
    term = '';
  }
  return xml;
}

// 按各列最长内容分配列宽，总宽不超过正文
function colgroup(rows) {
  const textWidth = xml => [...xml.replace(/<[^>]+>/g, '').replace(/&\w+;/g, '_')].reduce((n, ch) => n + (ch > '\xff' ? 2 : 1), 0);
  const weights = rows[0].map((_, i) => Math.min(80, Math.max(8, ...rows.map(r => textWidth(r[i] ?? '')))));
  const sum = weights.reduce((a, b) => a + b, 0);
  const total = Math.min(PAGE_WIDTH, sum * 9 + weights.length * 24);
  return `<colgroup>${weights.map(w => `<col width="${Math.max(MIN_COL_WIDTH, Math.round(total * w / sum))}"/>`).join('')}</colgroup>`;
}

const cellXml = (tag, { xml, align, color, media = '' }) =>
  `<${tag}${color ? ` background-color="${color}"` : ''}><p${align ? ` align="${align}"` : ''}>${xml}</p>${media}</${tag}>`;

// rows：单元格 { xml, align, color, media } 的二维数组，首行是表头
function tableXml([head, ...body]) {
  const row = (tag, cells) => `<tr>${cells.map(cell => cellXml(tag, cell)).join('')}</tr>`;
  return `<table>${colgroup([head, ...body].map(r => r.map(cell => cell.xml)))}`
    + `<thead>${row('th', head.map(cell => ({ ...cell, color: 'light-gray' })))}</thead>`
    + `<tbody>${body.map(r => row('td', r)).join('')}</tbody></table>`;
}

function table(node, c) {
  const caption = node.children.find(n => n.type === 'caption');
  const lead = node.token.meta?.classes?.includes('lead');
  const rows = node.children.filter(n => n !== caption).flatMap(n => n.children).map((tr, r) => tr.children.map((cell, i) => {
    const xml = inlineToken(firstInline(cell).token, c);
    const align = /text-align:(right|center)/.exec(cell.token.attrGet('style') ?? '')?.[1];
    return { xml: lead && r > 0 && i === 0 && xml ? bold(xml) : xml, align, media: flushMedia(c) };
  }));
  const title = caption ? `<p>${bold(inlineToken(firstInline(caption).token, c))}</p>` : '';
  return title + tableXml(rows);
}

function heatmap(token, attrs, c) {
  const [head, ...rows] = token.content.replace(/\r\n/g, '\n').trim().split('\n').map(csvRow);
  const plain = +(attrs.plain ?? 0);
  const bins = String(attrs.bins ?? '').split(',').filter(Boolean).map(Number);
  const cells = rows.map(r => r.map((v, i) => {
    const isTotal = r[0] === attrs.total;
    const heat = i > plain && !isTotal && v.trim() && bins.length;
    return { xml: isTotal ? bold(esc(v)) : esc(v), align: i ? 'right' : undefined, color: heat ? HEAT_COLORS[heatLevel(+v, bins) - 1] : undefined };
  }));
  const legend = bins.length
    ? `<p>${attrs.legend ? `${gray(inlineText(attrs.legend, c))} ` : ''}${heatLabels(bins).map((l, i) => `<span background-color="${HEAT_COLORS[i]}"> ${l} </span>`).join(' ')}</p>`
    : '';
  if (attrs['row-link'] || attrs['cell-link']) c.warnings.add('热力表的单元格链接不导出');
  return tableXml([head.map(h => ({ xml: esc(h) })), ...cells]) + legend;
}

function fence(node, c) {
  const { token } = node;
  const { lang, attrs } = parseFenceInfo(token.info);
  if (lang === 'plantuml-include') return '';
  if (lang === 'heatmap') return heatmap(token, attrs, c);
  if (['plantuml', 'mermaid', 'svg'].includes(lang)) {
    // 飞书只支持部分 PlantUML 语法，解析失败会丢掉整张图，所以用本机渲染的 SVG
    const isPlantUml = lang === 'plantuml';
    const source = isPlantUml ? c.env.plantuml.get(token).replace(/<\?[^?]*\?>/g, '') : token.content;
    const caption = attrs.caption ? `<p align="center">${gray(inlineText(attrs.caption, c))}</p>` : '';
    return `<whiteboard type="${isPlantUml ? 'svg' : lang}">${esc(source.trim())}</whiteboard>${caption}`;
  }
  const title = attrs.title ?? attrs.label;
  return `<pre lang="${esc(CODE_LANGS[lang] ?? lang)}"${title ? ` caption="${esc(title)}"` : ''}><code>${esc(token.content.replace(/\n$/, ''))}</code></pre>`;
}

const containerTitle = (node, name, c) => {
  const text = node.token.info.trim().slice(name.length).trim();
  return text ? `<p>${bold(inlineText(text, c))}</p>` : '';
};

function cards(node, c) {
  const columns = node.children.map(card => containerTitle(card, 'card', c) + blocks(card.children, c));
  let xml = '';
  for (let i = 0; i < columns.length; i += MAX_GRID_COLUMNS) {
    const row = columns.slice(i, i + MAX_GRID_COLUMNS);
    const ratio = (1 / row.length).toFixed(4);
    xml += row.length === 1 ? row[0] : `<grid>${row.map(x => `<column width-ratio="${ratio}">${x}</column>`).join('')}</grid>`;
  }
  return xml;
}

function recordBody(node, c) {
  const { sub, facts, links, desc, note } = node.token.meta;
  const text = s => inlineText(s, c);
  let xml = sub ? `<p>${bold(text(sub))}</p>` : '';
  if (facts.length) xml += `<p>${facts.map(([k, v]) => `${gray(text(k))} ${text(v)}`).join('　')}</p>`;
  if (links) xml += `<p>${text(links)}</p>`;
  if (desc) xml += `<p>${text(desc)}</p>`;
  if (note) xml += `<p>${gray(text(note))}</p>`;
  return xml + flushMedia(c);
}

const footnotes = (node, c) => `<hr/><ol>${node.children.map(note => `<li seq="auto">${listItem(note, c)}</li>`).join('')}</ol>`;

const BLOCKS = {
  paragraph, heading, table, fence,
  bullet_list: list,
  ordered_list: list,
  blockquote: (n, c) => n.token.meta?.callout ? callout(n, c) : `<blockquote>${blocks(n.children, c)}</blockquote>`,
  code_block: fence,
  hr: () => '<hr/>',
  dl: definitions,
  html_block: () => '',                     // 只有 records 的卡片外框
  hs_record_body: recordBody,
  container_cards: cards,
  container_details(n, c) {
    c.warnings.add('折叠段落展开为正文');
    return containerTitle(n, 'details', c) + blocks(n.children, c);
  },
  footnote_block: footnotes,
};

// 返回 { xml, title, warnings }；mdPath 用来定位本地图片与视频
export async function renderFeishu(text, { mdPath }) {
  const [front, source] = splitFrontMatter(text);
  const md = createMd();
  const env = { front };
  const tokens = md.parse(source, env);
  await preparePlantUml(tokens, env);
  const c = { md, env, front, dir: dirname(resolve(mdPath)), media: [], warnings: new Set() };
  const h1 = tokens.findIndex(t => t.type === 'heading_open' && t.tag === 'h1');
  const title = h1 >= 0 ? plainText(tokens[h1 + 1]) : front.title ?? basename(mdPath, '.md');
  const xml = `<title>${esc(title)}</title>\n${tree(tokens).map(n => block(n, c)).filter(Boolean).join('\n')}\n`;
  return { xml, title, warnings: [...c.warnings] };
}
