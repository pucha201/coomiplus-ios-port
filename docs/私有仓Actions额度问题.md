# 私有仓 Actions 为什么一直是红的

## 一句话

**先后有两件完全不同的事，被混成了一件：**

| 阶段 | 时间 | 症状 | 真因 | 状态 |
|---|---|---|---|---|
| A | ≈11:28 之前 | 有 runner、有步骤、跑几十秒到几分钟，红在 `build CoomiIOS.app` | **真的代码/路径 bug** | **已修，见下** |
| B | ≈11:28 之后 | 没有 runner、`steps` 为空、1–2 秒就失败 | 私有仓免费额度耗尽 | 等下月 1 日重置 |

把 A 当成 B，会得出「代码没问题、只是没额度」的错误结论；把 B 当成 A，
会去改根本没被执行的代码。两者必须分开看。

## 阶段 A：真的有个 bug（已修）

`engine` job 在这段时间是**绿的**——`43206509387` 上 `engine` 用了 297 秒并通过。
红的是 `build CoomiIOS.app`，卡在「取 iSH 运行时（内核 + fakefs rootfs）」：

```
-rw-r--r-- 1 runner staff 6581376 Nov 12 11:13 .../Resources/linux-rootfs.tar.gz
##[error]没有 linux-rootfs.tar.gz
```

**文件明明就在那儿，`ls -la` 刚把它列出来，下一行却说没有。**
原因是两套路径推导在打架：

- `scripts/fetch-ish.sh` 用**绝对** `$TARGET` 落盘并汇报成功；
- 工作流这边用**相对**路径 `test -s apps/ios/...`，按 `$GITHUB_WORKSPACE` 解析。

更早的 `c9e547e` 还把 `ROOT` 多推了一层，产物落到
`/Users/runner/work/coomiplus-ios/apps/...`（注意少了一层 checkout 目录名），
于是相对路径断言必然落空。`fetch-ish.sh` 的 L28–39 已经改成先看
`$HERE/..` 有没有 `apps/ios`，没有才回退 `git rev-parse --show-toplevel`。

剩下的一半修复刚做完：把所有断言锚到 `$GITHUB_WORKSPACE` 的绝对路径上，
并把两边的 cwd 打进日志。

```yaml
ROOTFS="$GITHUB_WORKSPACE/apps/ios/CoomiApp/Resources/linux-rootfs.tar.gz"
echo "GITHUB_WORKSPACE=$GITHUB_WORKSPACE"
echo "pwd=$(pwd)"
test -s "$ROOTFS" || { echo "::error::没有 linux-rootfs.tar.gz（$ROOTFS）"; exit 1; }
echo "rootfs 大小: $(stat -f%z "$ROOTFS") 字节"
```

同一条规则适用于「确认资源清单」那一步（`Resources` / `web/index.html`）。

**教训**：脚本说「完成」不等于工作流看得见。「写了」和「读得到」是两件事，
两处必须用同一个绝对基准，否则日志会自相矛盾。

## 阶段 B：额度耗尽（不是代码问题）

### 证据 1：所有 job 都是「0 步骤、2 秒、没有 runner」

```
run 43229128368  (2d17335)
   rust + web tests            failure  2s  runner=(空)
   engine (aarch64-apple-ios)  failure  2s  runner=(空)
```

`runner_name` 为空、`steps` 数组为空、`started_at` 与 `completed_at` 相差 2 秒。
真正的编译失败会有一个已分配的 runner、若干条步骤记录、几十秒以上的耗时。

### 证据 2：账单显示 macOS 分钟数已经爆掉

`GET /users/pucha201/settings/billing/usage`（2026-11 月，仓 `coomiplus-ios`）：

| SKU | 用量 | 单价 | 金额 |
|---|---|---|---|
| Actions Linux | **484 分钟** | $0.006 | $2.90 |
| Actions macOS 3-core | **440.26 分钟** | $0.062 | $27.30 |
| Actions storage | 51.5 GB·h | — | $0.02 |

macOS runner 对免费账户按 **10 倍** 计费，440.26 分钟实际扣 **4402 分钟**，
而私有仓免费额度是 **2000 分钟/月**。Linux 那 484 分钟是额外叠加。

`discountAmount` 等于 `grossAmount`，`netAmount` 为 0 —— 说明这些用量吃的是免费额度，
额度用尽后 GitHub 直接拒绝派发 runner。

### 证据 3：公开仓同样内容一次通过

公开仓 `pucha201/coomiplus-ios-port` 的 `d518da6`（run `43222980502`）：
engine ✅ / rust + web tests ✅ / build CoomiIOS.app ✅ / 验证 IPA 产物 ✅

**公开仓的 Actions 分钟数完全免费、不限额**，所以同样的 YAML、同样的 Rust 代码
在那边能跑完，在私有仓连 runner 都拿不到。

### 排查这条弯路时被逐一否掉的假设

| 假设 | 结论 |
|---|---|
| `coomi-jni` 的 `[lib] name = "coomi_engine"` 与 `coomi-engine` 冲突 | 本地 `cargo build` 能过，**不成立** |
| workspace 成员 `jni` 是私有仓独有的，导致解析失败 | `cargo metadata --filter-platform aarch64-apple-ios` 退出 0，**不成立** |
| `.cargo/config.toml` 里写了 Android linker 污染 iOS 构建 | 两仓内容仅差一行注释，**不成立** |
| `Cargo.lock` 不一致 | 私有仓多 `coomi-jni` 条目，属正常差异，**不成立** |
| `cargo build ... 2>&1 \| tail -40` 把错误截掉了 | 改法是好的，但**不是失败原因** |
| 「私有仓的 engine 从来构建不出来」 | **假**。`43206509387` 上 engine 297 秒通过 |

**教训**：`conclusion=failure` 不等于「构建失败」。先看
`runner_name` 是否为空、`steps` 是否有内容、耗时是否合理。
如果这三项都不正常，那连「代码有没有错」都还没轮到被检验。

## 现在的状态

- **公开仓已经全绿**，IPA 17.14 MB，验证器 35/35。这条链路是通的，产物是可用的。
- **私有仓在额度恢复前不会变绿**，无论怎么改代码。下月 1 日重置，或在
  Settings → Billing 加额度/换付费计划。
- 阶段 A 的路径修复已经落在两仓的 `build-ios.yml` 与 `fetch-ish.sh` 上，
  所以额度恢复后应当一次通过 —— 但这句话是**推断**，不是已验证事实。
  私有仓要真正验证，得等 runner 能被分配。

## 顺带说明：为什么不干脆只用公开仓

私有仓里放着 Android 端（`apps/coomi-app`，864 个文件）和 `apps/coomi-rs/jni/`，
这些是不公开的。iOS 子集已经单独同步到公开仓，构建与验证都在公开仓完成，
这也是「只有 iOS 公开」这个要求的自然结果。
