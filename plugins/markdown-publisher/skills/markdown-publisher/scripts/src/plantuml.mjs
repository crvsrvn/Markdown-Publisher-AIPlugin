// PlantUML 源码 → SVG：官方 @plantuml/core（TeaVM 浏览器构建，vendor/plantuml.js 原样使用）+ @viz-js/viz，不需要 Java。
// 引擎按浏览器设计，这里在 Node 中补上它用到的最小环境：linkedom 的 DOM，以及按本机字体测字的 canvas。
// 结果按引擎版本与源码哈希缓存到系统临时目录，重复导出不再渲染。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { parseHTML } from 'linkedom';
import { measureText } from './fonts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = '@plantuml/core 1.2026.8';
// v3：旧缓存里可能有丢了 note 的 SVG，换目录使其失效；缓存键另含引擎版本
const CACHE_DIR = join(tmpdir(), 'markdown-publisher', 'plantuml-v3');
const SVG_NS = 'http://www.w3.org/2000/svg';
const originalLog = console.log;

let enginePromise = null;

// 引擎把 Java 的 System.out 映射到 console.log，渲染期间静音
const muted = async fn => {
  console.log = () => {};
  try { return await fn(); } finally { console.log = originalLog; }
};

// canvas 2D 上下文的替身：只实现引擎用到的 font 与 measureText
function measureContext() {
  let font = { size: 14, family: 'sans-serif', bold: false };
  return {
    set font(value) {
      const m = /^(\S*)\s*([\d.]+)px\s+(.+)$/.exec(value);
      if (m) font = { bold: /bold|[6-9]00/.test(m[1]), size: +m[2], family: m[3] };
    },
    measureText(text) {
      const r = measureText(String(text), font.family, font.size, font.bold)
        ?? { width: String(text).length * font.size * 0.6, ascent: font.size * 0.8, descent: font.size * 0.2 };
      return { width: r.width, actualBoundingBoxAscent: r.ascent, actualBoundingBoxDescent: r.descent, fontBoundingBoxAscent: r.ascent, fontBoundingBoxDescent: r.descent };
    },
  };
}

function installBrowserEnv() {
  const { window, document } = parseHTML('<!doctype html><html><head></head><body></body></html>');
  const ctx = measureContext();
  const createElement = document.createElement.bind(document);
  document.createElement = tag => (tag === 'canvas' ? { getContext: () => ctx } : createElement(tag));
  // linkedom 没有布局：getBBox 返回 0 高度，引擎随即改用 fontBoundingBox 的上下高度
  Object.getPrototypeOf(document.createElementNS(SVG_NS, 'text')).getBBox ??= () => ({ width: 0, height: 0, x: 0, y: 0 });
  // linkedom 没有处理指令节点：用注释暂存，序列化时还原成 <?…?>
  Object.getPrototypeOf(document).createProcessingInstruction = function (target, data) { return this.createComment(`?${target} ${data}?`); };
  globalThis.XMLSerializer = class { serializeToString(node) { return node.toString().replace(/<!--\?([\s\S]*?)\?-->/g, '<?$1?>'); } };
  globalThis.DOMParser = window.DOMParser;
  globalThis.window = globalThis.self = globalThis;
  globalThis.document = document;
}

const loadEngine = () => (enginePromise ??= muted(async () => {
  const vizModule = await import('@viz-js/viz');
  let viz = null;
  globalThis.Viz = { instance: () => (viz ??= vizModule.instance()) };
  installBrowserEnv();
  return import(pathToFileURL(join(ROOT, 'vendor', 'plantuml.js')).href);
}));

const hashOf = text => createHash('sha1').update(text).digest('hex').slice(0, 16);
const decodeText = s => s.replace(/&#160;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// 语法错误时引擎不回调 onError，而是返回一张错误图：从中取出行号与最后一行错误信息
function syntaxError(svg, source) {
  const texts = [...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map(m => decodeText(m[1]).trim()).filter(Boolean);
  const head = texts.find(t => /^\[From .*\(line \d+\)\s*\]$/.test(t));
  if (!head) return null;
  const line = +/\(line (\d+)\)/.exec(head)[1];
  return `${texts.at(-1)}（第 ${line} 行：${source.split(/\r?\n/)[line - 1]?.trim() ?? ''}）`;
}

// 有警告（如过时语法）时引擎把警告画在图顶部的黄框（#FFDD88 边、#FFFFCC 底）里：取出框中的文字
function drawnWarnings(svg) {
  const m = /^<svg\b[^>]*>\s*(?:<defs\b[^>]*\/>|<defs\b[^>]*>[\s\S]*?<\/defs>)?\s*<g>\s*(<rect\b[^>]*>)((?:\s*<text\b[^>]*>[^<]*<\/text>)+)/.exec(svg);
  if (!m || !/stroke="#FFDD88"/i.test(m[1]) || !/fill="#FFFFCC"/i.test(m[1])) return [];
  return [...m[2].matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map(t => decodeText(t[1]).trim());
}

const drawSvg = (engine, source) => muted(() => new Promise((resolve, reject) =>
  engine.renderToString(source.split(/\r?\n/), resolve, message => reject(new Error(`PlantUML 渲染失败：${message}`)))));

// 活动图里 note 的首行：单行写法到冒号为止；多行写法整行，后面不能有别的内容（<style> 里的 note { 不算）
const NOTE_HEAD = /^\s*(?:floating )?note\s*(?:left|right)?\b(?:[^:{]*:|\s*(?:\$\S+\s*)*(?:<<.*>>)?\s*(?:#\S+)?\s*$)/i;
const NOTE_MARK = 0xa000; // 从彝文音节区起，按行下标给每个 note 一个字符作标记，不会被换行拆开
const INVALID_LINE = '@@@';

// 活动图的 if 带 elseif 时，引擎会丢弃挂在整个 if 上的 note，不报错也不警告。
// 给每个 note 的文字前加一个标记字符再画一次，没画出来的就是丢了的；返回它们的行号与首行。
async function lostNotes(engine, source) {
  // 要求有 endif 行，排除时序图里 alt 的 else if
  if (!/else\s*if/i.test(source) || !/^\s*end\s*if\b/im.test(source)) return [];
  const lines = source.split(/\r?\n/);
  const notes = lines.map((_, i) => i).filter(i => NOTE_HEAD.test(lines[i]));
  if (!notes.length) return [];
  const markOf = i => String.fromCharCode(NOTE_MARK + i);
  const marked = lines.map((line, i) => {
    const head = NOTE_HEAD.exec(line)?.[0];
    if (!head) return line;
    return head.endsWith(':') ? `${head} ${markOf(i)} ${line.slice(head.length)}` : `${line}\n${markOf(i)}`;
  }).join('\n');
  const drawn = await drawSvg(engine, marked);
  if (syntaxError(drawn, marked)) return [];
  const lost = [];
  for (const i of notes) {
    if (drawn.includes(markOf(i))) continue;
    // 块注释、未成立的 !if、未调用的 !procedure 里的 note 本来就不画：在那里插入错误行不会报语法错误
    const broken = [...lines.slice(0, i), INVALID_LINE, ...lines.slice(i)].join('\n');
    if (syntaxError(await drawSvg(engine, broken), broken)) lost.push(`图源码第 ${i + 1} 行：${lines[i].trim()}`);
  }
  return lost;
}

// 渲染单张图，返回 SVG 字符串；语法错误、引擎丢了 note 时抛出带行号的异常；有警告时也抛出，因为引擎会把警告画进图里
export async function renderPlantUml(source) {
  const file = join(CACHE_DIR, hashOf(`${ENGINE}\n${source}`) + '.svg');
  if (existsSync(file)) return readFileSync(file, 'utf8');
  const engine = await loadEngine();
  const svg = await drawSvg(engine, source);
  const error = syntaxError(svg, source);
  if (error) throw new Error(`PlantUML 渲染失败：${error}`);
  const warnings = drawnWarnings(svg);
  if (warnings.length) throw new Error(`PlantUML 警告（会画进图里）：\n  ${warnings.join('\n  ')}`);
  const lost = await lostNotes(engine, source);
  if (lost.length) {
    throw new Error(`PlantUML 的 note 没有画出来（引擎会丢弃挂在带 elseif 的 if 上的 note）：\n  ${lost.join('\n  ')}\n`
      + '  改法：把 note 移到某个分支的动作之后，或把 elseif 改成嵌套的 else + if … endif');
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, svg);
  return svg;
}

// 解码 SVG 里 <?plantuml-src …?> 内嵌的源码（PlantUML 文本编码：raw deflate + 自定义 64 进制字母表）
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';
export function decodePlantUmlSrc(encoded) {
  const bytes = [];
  for (let i = 0; i < encoded.length; i += 4) {
    const [c1, c2, c3, c4] = [0, 1, 2, 3].map(k => ALPHABET.indexOf(encoded[i + k] ?? '0') & 0x3f);
    bytes.push((c1 << 2) | (c2 >> 4), ((c2 & 0xf) << 4) | (c3 >> 2), ((c3 & 0x3) << 6) | c4);
  }
  return inflateRawSync(Buffer.from(bytes), { finishFlush: 2 }).toString('utf8');
}
