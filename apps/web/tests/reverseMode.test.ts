import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeFlavor, flavorLabel, REVERSE_FLAVORS, REVERSE_FLAVOR_VALUES,
  consentSignature, writeConsent, hasValidConsent, readConsent,
  reversePillState, reversePillLabel, reversePillTitle,
  preconditionsMet, missingPreconditions,
  REVERSE_CONSENT_VERSION, REVERSE_CONSENT_KEY,
} from '../src/utils/reverseMode.ts'

/**
 * 逆向模式的状态机有十几条分支，每条错法都会造成同一类最糟的失败：
 * 「用户以为关了，其实还带着逆向契约在跑」。所以判定逻辑全抽成纯函数，
 * 在这里逐条钉死。
 */

/** 最小 localStorage 替身。 */
function fakeStorage() {
  const map = new Map()
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) },
  }
}

/* ── 口味 ──────────────────────────────────────────────────────────────── */

test('口味：未知值一律归到 generic，不抛异常', () => {
  assert.equal(normalizeFlavor('deepseek'), 'deepseek')
  assert.equal(normalizeFlavor('DEEPSEEK'), 'generic', '大小写不匹配应视为未知')
  assert.equal(normalizeFlavor('claude'), 'generic')
  assert.equal(normalizeFlavor(null), 'generic')
  assert.equal(normalizeFlavor(undefined), 'generic')
  assert.equal(normalizeFlavor(42), 'generic')
})

test('口味：generic 永远排第一（默认项不能藏在列表中间）', () => {
  assert.equal(REVERSE_FLAVORS[0].value, 'generic')
  assert.deepEqual(REVERSE_FLAVOR_VALUES, REVERSE_FLAVORS.map(item => item.value))
})

test('口味：每个选项都有非空 label 与 hint', () => {
  for (const item of REVERSE_FLAVORS) {
    assert.ok(item.label.length > 0, `${item.value} 缺 label`)
    assert.ok(item.hint.length > 0, `${item.value} 缺 hint`)
  }
})

test('口味：flavorLabel 对未知值退回「通用」', () => {
  assert.equal(flavorLabel('generic'), '通用')
  assert.equal(flavorLabel('nope'), '通用')
})

/* ── 免责同意 ──────────────────────────────────────────────────────────── */

test('同意：没有记录时 hasValidConsent 为 false', () => {
  assert.equal(hasValidConsent(fakeStorage()), false)
  assert.equal(hasValidConsent(undefined), false)
})

test('同意：写入后可读回，且版本与指纹都对得上', () => {
  const storage = fakeStorage()
  const record = writeConsent(storage, 1_700_000_000)
  assert.ok(record)
  assert.equal(record.version, REVERSE_CONSENT_VERSION)
  assert.equal(record.sig, consentSignature(REVERSE_CONSENT_VERSION, 1_700_000_000))
  assert.equal(hasValidConsent(storage), true)
  assert.deepEqual(readConsent(storage), record)
})

test('同意：指纹与版本、时间戳绑定，改任一项都失效', () => {
  const base = consentSignature(1, 1000)
  assert.notEqual(consentSignature(2, 1000), base, '版本变了指纹必须变')
  assert.notEqual(consentSignature(1, 1001), base, '时间戳变了指纹必须变')
  assert.equal(consentSignature(1, 1000), base, '同输入必须同输出，否则每次启动都要重新征询')
})

test('同意：手改 version 拨高会被指纹挡住', () => {
  const storage = fakeStorage()
  writeConsent(storage, 1_700_000_000)
  const raw = JSON.parse(storage.getItem(REVERSE_CONSENT_KEY))
  storage.setItem(REVERSE_CONSENT_KEY, JSON.stringify({ ...raw, version: 999 }))
  assert.equal(hasValidConsent(storage), false, '拨高版本但没有同步改 sig，必须判无效')
})

test('同意：损坏的 JSON / 少字段 / 非对象一律判无效，不抛异常', () => {
  for (const garbage of ['', 'not json', 'null', '[]', '{}', '{"version":"1"}', '{"version":1}']) {
    const storage = fakeStorage()
    storage.setItem(REVERSE_CONSENT_KEY, garbage)
    assert.equal(hasValidConsent(storage), false, `垃圾输入 ${garbage} 不应通过`)
  }
})

test('同意：storage 抛异常时安全返回 false（隐私模式下 localStorage 会抛）', () => {
  const hostile = {
    getItem() { throw new Error('blocked') },
    setItem() { throw new Error('blocked') },
  }
  assert.equal(hasValidConsent(hostile), false)
  assert.equal(writeConsent(hostile), null)
})

/* ── pill 状态机 ───────────────────────────────────────────────────────── */

const ON = { target: true, committed: true, consented: true, permitted: true }
const OFF = { target: false, committed: false, consented: true, permitted: true }

test('pill：关着时是 off', () => {
  assert.equal(reversePillState(OFF), 'off')
})

test('pill：开且已提交且允许 → on', () => {
  assert.equal(reversePillState(ON), 'on')
})

test('pill：未同意时点开是 arming（不能让人以为已在跑）', () => {
  assert.equal(reversePillState({ ...ON, consented: false }), 'arming')
  assert.equal(reversePillState({ ...OFF, consented: false }), 'off', '没点过就不打扰')
})

test('pill：生成中翻开关 → pending，两个方向都要说出来', () => {
  assert.equal(reversePillState({ ...ON, committed: false }), 'pending', '生成中开启')
  assert.equal(reversePillState({ ...OFF, committed: true }), 'pending', '生成中关闭')
})

test('pill：开着但引擎报受限 → blocked', () => {
  assert.equal(reversePillState({ ...ON, permitted: false }), 'blocked')
})

test('pill：受限但关着不该显示受限', () => {
  assert.equal(reversePillState({ ...OFF, permitted: false }), 'off')
})

test('pill：文案必须区分「待生效」的两个方向', () => {
  const opening = reversePillLabel({ ...ON, committed: false })
  const closing = reversePillLabel({ ...OFF, committed: true })
  assert.notEqual(opening, closing)
  assert.match(opening, /待生效/)
  assert.match(closing, /待生效/)
})

test('pill：开着的 label 是「逆向」', () => {
  assert.equal(reversePillLabel(ON), '逆向')
})

test('pill：title 里带当前口味，且提示长按', () => {
  const title = reversePillTitle({ ...ON, flavor: 'openai' })
  assert.match(title, /GPT 系/)
  assert.match(title, /长按/)
})

test('pill：blocked 的 title 说明怎么办，而不是只说不行', () => {
  assert.match(reversePillTitle({ ...ON, permitted: false }), /权限/)
})

/* ── 前提条件 ──────────────────────────────────────────────────────────── */

test('前提：有模型且可写就算满足（无原生工具不阻断）', () => {
  assert.equal(preconditionsMet({ hasModel: true, writableAccess: true, nativeTools: false }), true)
})

test('前提：只读或缺模型都不满足', () => {
  assert.equal(preconditionsMet({ hasModel: false, writableAccess: true, nativeTools: true }), false)
  assert.equal(preconditionsMet({ hasModel: true, writableAccess: false, nativeTools: true }), false)
})

test('前提：缺失项逐条列出来，全满足时为空数组', () => {
  assert.deepEqual(missingPreconditions({ hasModel: true, writableAccess: true, nativeTools: true }), [])
  const missing = missingPreconditions({ hasModel: false, writableAccess: false, nativeTools: false })
  assert.equal(missing.length, 3)
  for (const text of missing) assert.ok(text.length > 0)
})

test('前提：无原生工具只是建议项，文案指向 local_shell', () => {
  const missing = missingPreconditions({ hasModel: true, writableAccess: true, nativeTools: false })
  assert.equal(missing.length, 1)
  assert.match(missing[0], /local_shell/)
})
