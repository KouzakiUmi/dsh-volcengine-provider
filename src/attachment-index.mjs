// 会话图片附件索引：把模型在请求历史里见过的图片附件完整引用记住，供图片工具补全参数。
//
// 背景：Core 的 pi-ai 适配器会在每个图片块旁插入 handle 文本
// （`Image "name" (sha256:…)`），但 handle 只有内容 ID，没有 bytes/width/height；
// 模型据此无法构造 attachments.readImage 需要的完整 ImageAttachmentRef，于是
// volc_imagine 想用会话里的图片时会失败。本模块在模型请求前扫描 messages 的图片块，
// 按内容哈希保存完整引用，让工具在模型只给 sha256（或“会话最近一张图”）时自动补全。
const FULL_ID = /^sha256:[a-f0-9]{64}$/u;
const PREFIX_ID = /^sha256:[a-f0-9]{8,64}$/u;
const MEDIA_TYPE = /^image\/[a-z0-9.+-]+$/u;

export const MAX_INDEX_ENTRIES = 512;
export const MAX_SESSION_ENTRIES = 64;
// 会话数上限约束的是“同时有图的会话数”。超出时挤掉最久未写入的会话，其 session-latest
// 会明确报错（fail-safe），完整 sha256 引用不受影响；当前 harness 规模（全树活跃子代理 ≤25）足够。
export const MAX_SESSIONS = 32;
export const MIN_PREFIX_HEX = 8;

function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function sessionKey(sessionId) {
  if (sessionId === undefined || sessionId === null) return undefined;
  const key = String(sessionId);
  return key.length ? key : undefined;
}

/** 只接受可被附件服务校验通过的完整图片引用；缺字段或类型不符时返回 undefined。 */
export function completeImageRef(ref) {
  if (ref === null || typeof ref !== 'object') return undefined;
  const attachmentId = String(ref.attachmentId ?? '');
  if (!FULL_ID.test(attachmentId)) return undefined;
  if (typeof ref.mediaType !== 'string' || !MEDIA_TYPE.test(ref.mediaType)) return undefined;
  if (!positive(ref.bytes) || !positive(ref.width) || !positive(ref.height)) return undefined;
  const copy = { attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height };
  if (typeof ref.name === 'string' && ref.name.length > 0) copy.name = ref.name;
  if (ref.originalDimensions !== null && typeof ref.originalDimensions === 'object'
    && positive(ref.originalDimensions.width) && positive(ref.originalDimensions.height)) {
    copy.originalDimensions = { width: ref.originalDimensions.width, height: ref.originalDimensions.height };
  }
  return copy;
}

/**
 * 建立按内容哈希与会话隔离的图片附件索引。
 * 完整 ID 全局去重（内容寻址，同 ID 必同内容）；“最近一张”按会话隔离，避免跨会话取错图。
 */
export function createAttachmentIndex({ limit = MAX_INDEX_ENTRIES, perSession = MAX_SESSION_ENTRIES, maxSessions = MAX_SESSIONS } = {}) {
  const refs = new Map();
  const sessions = new Map();
  let seq = 0;

  function trimGlobal() {
    while (refs.size > limit) {
      let oldestId, oldest = Infinity;
      for (const [id, entry] of refs) {
        if (entry.seq < oldest) { oldest = entry.seq; oldestId = id; }
      }
      if (oldestId === undefined) break;
      refs.delete(oldestId);
      // 淘汰后同步剔除会话表里的悬空 id，避免 only-latest 路径长期持有失效条目。
      for (const [key, list] of sessions) {
        const kept = list.filter(value => value !== oldestId);
        if (kept.length) sessions.set(key, kept);
        else sessions.delete(key);
      }
    }
  }

  function rememberSession(key, id) {
    if (key === undefined) return;
    const previous = sessions.get(key);
    // 重新写入会话表时移到末尾，保持 Map 顺序即最近写入顺序，便于按会话淘汰。
    if (previous !== undefined) sessions.delete(key);
    const list = (previous ?? []).filter(value => value !== id);
    list.push(id);
    while (list.length > perSession) list.shift();
    sessions.set(key, list);
    while (sessions.size > maxSessions) {
      const oldestKey = sessions.keys().next().value;
      if (oldestKey === undefined) break;
      sessions.delete(oldestKey);
    }
  }

  /** 记住一个完整图片引用；不完整引用静默忽略（它本来也无法读取）。 */
  function remember(ref, sessionId) {
    const copy = completeImageRef(ref);
    if (!copy) return false;
    const id = copy.attachmentId;
    refs.set(id, { ref: copy, seq: ++seq });
    trimGlobal();
    rememberSession(sessionKey(sessionId), id);
    return true;
  }

  /**
   * 扫描一条已组装的模型请求的 messages，登记其中出现的所有图片附件引用。
   * 图片块来自用户上传、工具结果和历史回放；offloaded 块仍带引用，同样登记。
   * @returns 新登记或刷新的图片数量。
   */
  function observeRequest({ sessionId, messages } = {}) {
    const key = sessionKey(sessionId);
    let count = 0;
    for (const message of Array.isArray(messages) ? messages : []) {
      const content = message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type !== 'image' || !block.attachment) continue;
        if (remember(block.attachment, key)) count += 1;
      }
    }
    return count;
  }

  /**
   * 按完整内容 ID 或 8–63 位十六进制短前缀查找引用。
   * @returns `{ ref }` 命中、`{ ambiguous: [...] }` 短前缀歧义，或 undefined 未命中。
   */
  function resolve(value) {
    const text = String(value ?? '').trim();
    if (FULL_ID.test(text)) {
      const entry = refs.get(text);
      return entry ? { ref: entry.ref } : undefined;
    }
    if (!PREFIX_ID.test(text) || text.length <= 'sha256:'.length + MIN_PREFIX_HEX - 1) return undefined;
    const matches = [...refs.keys()].filter(id => id.startsWith(text));
    if (matches.length === 1) return { ref: refs.get(matches[0]).ref };
    if (matches.length > 1) return { ambiguous: matches };
    return undefined;
  }

  /**
   * 会话最近一张图片。严格限本会话：会话标识缺失或本会话没有图片时返回 undefined，
   * 绝不回退到全局最近——那会把别的会话的图当成“用户刚给的那张”，属于静默取错图。
   */
  function latest(sessionId) {
    const key = sessionKey(sessionId);
    if (key === undefined) return undefined;
    const list = sessions.get(key) ?? [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const entry = refs.get(list[index]);
      if (entry) return entry.ref;
    }
    return undefined;
  }

  function count() { return refs.size; }

  function clear() {
    refs.clear();
    sessions.clear();
    seq = 0;
  }

  return { remember, observeRequest, resolve, latest, count, clear };
}
