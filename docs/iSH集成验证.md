# iSH 集成验证：从「有 rootfs」到「真能跑命令」

这份文档记录「AI 能否在 App 内执行 Linux 命令」这件事到底验证到什么程度，
以及哪些是**实测过的**、哪些还是**推断的**。

---

## 结论先说

| 层面 | 状态 | 证据 |
|---|---|---|
| 内核编译 | ✅ 实测 | `libish.a` 61 个 arm64 目标文件，1.57 MB |
| 内核链接 | ✅ 实测 | 主二进制里有 20 个 `libIshKernel.a(...)` 成员 |
| fakefs 格式 | ✅ 实测 | `meta.db` 192,512 B，SQLite，2 张表，2,951 条路径 |
| PID1 supervisor | ✅ 实测 | `data/sbin/ishsv` 46,192 B，ELF64 EM_AARCH64 |
| 用户态二进制 | ✅ 实测 | `busybox` 919,232 B，ELF64 EM_AARCH64 |
| 解包算法 | ✅ 实测 | 856 文件 / 208 目录，与归档一致 |
| **运行时执行命令** | ⚠ **未实测** | 需要真机，见最后一节 |

**能确认的是：App 里确实有一个完整的内核 + 文件系统 + supervisor。**
**不能确认的是：它在真机上 boot 起来之后 `sh -c 'echo ok'` 真的返回 ok。**

---

## 一、fakefs 才是 iSH 要的 rootfs

`ishembed.h` 里 `rootfs_path` 的注释是：

```c
const char *rootfs_path;  /* host fs path to fakefs root
                             (the dir that has data/ + meta.db) */
```

也就是说它要的不是「Alpine tar 解出来的目录」，而是 iSH 自己的 **fakefs 镜像**。
两者区别：

| | 普通 Alpine rootfs | iSH fakefs |
|---|---|---|
| 文件内容 | `bin/` `etc/` `usr/` 直接铺在根下 | 真实内容在 `data/` 下 |
| 元数据 | 无（靠 tar 头） | `meta.db`（SQLite，记 inode/权限/时间戳） |
| PID1 | 需要自己准备 | 内置 `/sbin/ishsv` |
| 来源 | `alpine-minirootfs-*.tar.gz` | 上游 release 的 `fs.tar.gz`（`fakefsify` 生成） |

我最初打的是前者。**格式不对的话 boot 会挂在 `ISH_ERR_MOUNT(-2)`
或 `ISH_ERR_EXECVE(-6)`，但构建阶段一切正常** —— 这是最难发现的那类错误。

### 实测数据（`fs.tar.gz`，6,581,376 B）

解包后 3,192 个条目：
- 1,920 个普通文件条目，其中 **1,064 个是 `._xxx`**（AppleDouble，各 163 字节）
- 真实文件 **856 个**，目录 208 个
- 另有 1,064 个 PAX 扩展头，数量与 AppleDouble 一一对应

所以「过滤掉 1064」不是丢文件 —— 本来就该丢。

关键文件：

```
meta.db              192,512 B   SQLite，CREATE TABLE paths / stats
meta.db-shm           32,768 B
meta.db-wal                0 B
data/sbin/ishsv       46,192 B   ELF64 EM_AARCH64
data/bin/busybox     919,232 B   ELF64 EM_AARCH64
data/bin/sh               12 B
```

`meta.db` 内含 **2,951 条可读路径**（`/bin/ls`、`/usr/bin/sort`、`/etc/passwd`、
`/sbin/fsck` …），4096 字节页 × 47 页，两张表都在。

---

## 二、路径映射：guest `/x` ↔ host `<root>/data/x`

iSH 的 fakefs 里，guest 看到的 `/bin/busybox` 对应宿主 `<root>/data/bin/busybox`。
所以把 `fs/` 的内容提到 `<root>` 之后：

- guest `/sbin/ishsv` → `<root>/data/sbin/ishsv` ✅
- guest `/bin/busybox` → `<root>/data/bin/busybox` ✅

`supervisor_guest_path` 默认 `/sbin/ishsv`，正好对上。

---

## 三、解包器（TarGzExtractor.swift）

iOS 不许 fork/exec，所以解 tar 只能自己在宿主侧做。
用 `Compression` framework 解 gzip，自己解析 tar 头。

### 踩过的两个坑

**① 普通文件的 type 字节是 ASCII `'0'`（0x30 = 48），不是 0。**

写成 `case 0, 0x00` 时，1,920 个文件全部不匹配，
结果只解出目录树、一个文件都没有，而 `extract()` 照样返回成功。
这种「静默少解」最难查，因为不报错。

**② `COMPRESSION_ZLIB` 是 raw DEFLATE，不是「带 zlib 头的流」。**

实测 `fs.tar.gz` 的 deflate 体前两字节 `ec 7d`：
- `(0xec << 8 | 0x7d) = 60541`
- `60541 % 31 = 29 ≠ 0` → 没有 zlib 头（zlib 头要求 `%31 == 0`）
- node 里 `inflateRawSync` 成功解出 18,838,016 B
- 而 `inflateSync`（按 zlib 解析）报 `incorrect header check`

gzip 头是我们手工剥掉的，所以正好对上。

---

## 四、链接验证：为什么不能用符号名做判据

这是本次最有价值的一条教训。

最初断言 `ish_embed_boot` / `become_first_process` 这些**符号名**在二进制里出现。
实测：**全部 0 次**。但 iSH 明明链进去了。

原因是 Release 构建会 strip 符号表。

改用「调试信息里残留的目标文件名」：

```
.../libIshKernel.xcframework/ios-arm64/libIshKernel.a(kernel_task.c.o)
```

静态库每个被抽用的 `.o` 都会留下这么一条，strip 不掉。实测 20 个：

```
asbestos_asbestos.c.o    emu_tlb.c.o              fs_adhoc.c.o
fs_fake.c.o              fs_fd.c.o                fs_inode.c.o
fs_mount.c.o             fs_poll.c.o              fs_real.c.o
kernel_errno.c.o         kernel_futex.c.o         kernel_log.c.o
kernel_memory.c.o        kernel_mmap.c.o          kernel_native_offload.c.o
kernel_signal.c.o        kernel_task.c.o          kernel_vdso.c.o
util_fifo.c.o            util_sync.c.o
```

fakefs（`fs_fake`/`fs_inode`/`fs_mount`）、任务调度（`kernel_task`）、
内存管理（`kernel_memory`/`kernel_mmap`）、TLB（`emu_tlb`）全在。

**「符号不存在」和「代码不存在」是两件事。**
按原判据会得出「iSH 没集成」的错误结论，然后去瞎改已经正确的东西。

---

## 五、产物实测

```
IPA            17.14 MB（未签名）
主二进制       28.30 MB  Mach-O arm64 MH_EXECUTE
linux-rootfs    6.28 MB  fakefs
web/           95 文件
```

对比接入 iSH 之前的 14.48 MB：增加 2.66 MB
（内核 2.87 MB 链接后实际增量 + fakefs 差额 - Alpine tar 差额）。

验证器 35 项断言全过。

---

## 六、还没验证的部分（诚实说明）

**`ish_embed_boot` 在真机上能否成功，以及 `sh -c 'echo ok'` 能否返回，我没有实测。**

原因：需要真机 + 签名。当前产物是未签名 IPA，只能自签侧载。

代码层面已按 ABI 逐字段核对：

| 结构体 | 字段 | 与 `ishembed.h` |
|---|---|---|
| `ish_embed_boot_opts_t` | `rootfs_path` `workdir` `supervisor_guest_path` `kernel_log_fd` `reserved_flags` | ✅ 一致 |
| `ish_embed_spawn_opts_t` | `argv` `cwd` `envp` `allocate_tty` `merge_stderr_into_stdout` `timeout_ms` `chroot_path` `reserved_flags` | ✅ 一致 |
| `ish_embed_oneshot_result_t` | `exit_code` `signal` `stdout_buf` `stdout_len` `stderr_buf` `stderr_len` `timed_out` | ✅ 一致 |
| 错误码 | `ISH_ERR_BOOT=-1` … `ISH_ERR_INVALID_ARG=-13` | ✅ 一致 |

boot 顺序也已修正：**先铺 fakefs，再 boot**（原来是先 boot 空目录，
那必然挂在 `ISH_ERR_MOUNT`，而且空 fakefs 里没有 `/bin/tar`，是个死结）。

boot 成功后还会自检一条 `/bin/sh -c 'echo coomi-ok; uname -s'`，
失败会在 NSLog 里留下原因 —— 真机上跑一次就能确认。

### 真机验证步骤

1. 用自签工具给 IPA 签名（或用 Xcode 直接跑）
2. 安装后看 Console.app 里 `[iSH]` 前缀的日志
3. 预期看到 `fakefs 解包完成，856 个条目` 和 `userland 自检通过`
4. 若失败，错误信息会指出具体是哪一步（`ISH_ERR_*` 有中文描述）
