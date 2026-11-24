// 会话图片附件索引测试：纯内存逻辑，不接触宿主附件服务或网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAttachmentIndex, completeImageRef, MAX_INDEX_ENTRIES } from '../src/attachment-index.mjs';

const id = hex => `sha256:${hex.repeat(64 / hex.length)}`;
const PNG_ID = id('a');
const JPEG_ID = id('b');
const WEBP_ID = id('c');

const ref = (attachmentId, extra = {}) => ({
  attachmentId, mediaType: 'image/png', bytes: 1024, width: 640, height: 480, ...extra
});
const imageBlock = attachment => ({ type: 'image', attachment });

test('completeImageRef 只接受完整图片引用', () => {
  assert.deepEqual(completeImageRef(ref(PNG_ID, { name: 'a.png' })), {
    attachmentId: PNG_ID, mediaType: 'image/png', bytes: 1024, width: 640, height: 480, name: 'a.png'
  });
  assert.equal(completeImageRef(ref('sha256:abc')), undefined);
  assert.equal(completeImageRef(ref(PNG_ID, { mediaType: 'video/mp4' })), undefined);
  assert.equal(completeImageRef(ref(PNG_ID, { bytes: 0 })), undefined);
  assert.equal(completeImageRef(ref(PNG_ID, { width: 1.5 })), undefined);
  assert.equal(completeImageRef(null), undefined);
});

test('observeRequest 登记 messages 里的图片块，offloaded 也算', () => {
  const index = createAttachmentIndex();
  const count = index.observeRequest({
    sessionId: 's1',
    messages: [
      { role: 'user', content: [
        { type: 'text', text: '改这张图' },
        imageBlock(ref(PNG_ID)),
        { type: 'image', attachment: ref(JPEG_ID), offloaded: true }
      ] },
      { role: 'tool', content: [{ type: 'text', text: 'no image' }] },
      { role: 'user', content: 'plain text' }
    ]
  });
  assert.equal(count, 2);
  assert.equal(index.count(), 2);
  assert.equal(index.resolve(PNG_ID).ref.attachmentId, PNG_ID);
  assert.equal(index.resolve(JPEG_ID).ref.attachmentId, JPEG_ID);
});

test('resolve 支持完整 ID 与 8 位以上短摘要，歧义时返回候选', () => {
  const index = createAttachmentIndex();
  index.remember(ref(PNG_ID));
  index.remember(ref(JPEG_ID));
  assert.equal(index.resolve(PNG_ID).ref.attachmentId, PNG_ID);
  assert.equal(index.resolve(PNG_ID.slice(0, 7 + 10)).ref.attachmentId, PNG_ID);
  assert.equal(index.resolve(`sha256:${'0'.repeat(64)}`), undefined);
  assert.equal(index.resolve('sha256:aaaa'), undefined);

  index.remember(ref(`sha256:${'a'.repeat(12)}${'d'.repeat(52)}`));
  const ambiguous = index.resolve('sha256:aaaaaaaaaaaa');
  assert.equal(ambiguous.ambiguous.length, 2);
});

test('latest 严格按会话隔离，缺会话信息时不回退全局', () => {
  const index = createAttachmentIndex();
  index.observeRequest({ sessionId: 's1', messages: [{ role: 'user', content: [imageBlock(ref(PNG_ID))] }] });
  index.observeRequest({ sessionId: 's2', messages: [{ role: 'user', content: [imageBlock(ref(JPEG_ID))] }] });
  assert.equal(index.latest('s1').attachmentId, PNG_ID);
  assert.equal(index.latest('s2').attachmentId, JPEG_ID);
  assert.equal(index.latest('unknown'), undefined);
  // 会话标识缺失时必须失败而不是猜一张别的会话的图。
  assert.equal(index.latest(undefined), undefined);
  assert.equal(index.latest(null), undefined);
  assert.equal(index.latest(''), undefined);
});

test('同一会话再次出现同一图片会刷新为最近一张并去重', () => {
  const index = createAttachmentIndex();
  index.observeRequest({ sessionId: 's1', messages: [{ role: 'user', content: [imageBlock(ref(PNG_ID)), imageBlock(ref(JPEG_ID))] }] });
  index.observeRequest({ sessionId: 's1', messages: [{ role: 'user', content: [imageBlock(ref(PNG_ID))] }] });
  assert.equal(index.latest('s1').attachmentId, PNG_ID);
  assert.equal(index.count(), 2);
});

test('超过全局上限时淘汰最旧条目', () => {
  const index = createAttachmentIndex({ limit: 2, perSession: 2 });
  index.remember(ref(PNG_ID), 's1');
  index.remember(ref(JPEG_ID), 's1');
  index.remember(ref(WEBP_ID), 's1');
  assert.equal(index.count(), 2);
  assert.equal(index.resolve(PNG_ID), undefined);
  assert.equal(index.latest('s1').attachmentId, WEBP_ID);
});

test('每会话只保留最近若干张，clear 清空全部', () => {
  const index = createAttachmentIndex({ perSession: 2 });
  index.remember(ref(PNG_ID), 's1');
  index.remember(ref(JPEG_ID), 's1');
  index.remember(ref(WEBP_ID), 's1');
  assert.equal(index.latest('s1').attachmentId, WEBP_ID);
  index.remember(ref(PNG_ID), 's1');
  assert.equal(index.latest('s1').attachmentId, PNG_ID);
  index.clear();
  assert.equal(index.count(), 0);
  assert.equal(index.latest('s1'), undefined);
});

test('默认全局上限覆盖正常会话规模', () => {
  assert.ok(MAX_INDEX_ENTRIES >= 256);
});

test('会话数有上限，且全局淘汰后不留悬空会话条目', () => {
  const index = createAttachmentIndex({ limit: 2, perSession: 2, maxSessions: 2 });
  index.remember(ref(PNG_ID), 's1');
  index.remember(ref(JPEG_ID), 's2');
  index.remember(ref(WEBP_ID), 's3');
  // 三个会话只保留最近两个。
  assert.equal(index.latest('s1'), undefined);
  assert.equal(index.latest('s2').attachmentId, JPEG_ID);
  assert.equal(index.latest('s3').attachmentId, WEBP_ID);
  // 全局上限 2 淘汰最旧后，会话表不应再返回被淘汰的 id。
  index.remember(ref(id('d')), 's3');
  assert.equal(index.count(), 2);
  assert.equal(index.resolve(JPEG_ID), undefined);
  assert.equal(index.latest('s2'), undefined);
  assert.equal(index.latest('s3').attachmentId, id('d'));
});

test('重复写入同一会话会刷新其最近顺序', () => {
  const index = createAttachmentIndex({ perSession: 2, maxSessions: 2 });
  index.remember(ref(PNG_ID), 's1');
  index.remember(ref(JPEG_ID), 's2');
  index.remember(ref(WEBP_ID), 's1');
  // s1 仍存在且最近一张是 WEBP；再加新会话把 s1 挤出前不该丢 s1。
  assert.equal(index.latest('s1').attachmentId, WEBP_ID);
  index.remember(ref(id('e')), 's3');
  assert.equal(index.latest('s2'), undefined);
  assert.equal(index.latest('s1').attachmentId, WEBP_ID);
});
