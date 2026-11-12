//
//  ish_support.c
//  Coomi 的 iSH 桥接层（C 侧）
//
//  ============ 这个文件干什么 ============
//
//  iSH 是**跑在 App 进程内的 Linux 内核**（fakefs + 线程化解释器），
//  在架构里等价于安卓的 proot：给 AI 一个能执行 shell 命令的环境。
//
//  Swift 不能直接 `#include` iSH 的头（大量内核内部类型、`current` 这类
//  线程局部宏），所以由本文件做 C 侧适配：把 `include/ishembed.h`
//  的 ABI 收拢成少数几个函数，并负责「有没有链接 iSH」的编译期分支。
//
//  ============ 为什么不用 xX_main_Xx ============
//
//  早期版本直接调 iSH 上游的内部 API（`xX_main_Xx` → `do_mount(procfs)`
//  → `do_execve` → `task_start`）。这条路的问题：
//    ① 全是内核内部符号，iSH 一改重构就全挂（已真实发生过）；
//    ② 它是给「完整 App」设计的入口，会自己装 UI、自己管生命周期；
//    ③ 需要 `#include "kernel/task.h"` 等一堆私有头。
//
//  `ish-arm64-pkg` 提供了**嵌入式 ABI**（`ishembed.h`，ABI v1），
//  官方就是为「把 iSH 当库嵌进别人的 App」准备的：
//    ish_embed_boot / ish_embed_run_oneshot / ish_embed_spawn / ish_embed_session_*
//  我们改为只依赖这套稳定 ABI。
//
//  ============ COOMI_HAS_ISH ============
//
//  由 project.yml 的 GCC_PREPROCESSOR_DEFINITIONS 控制：
//    0 → 桩实现（不链接 libish.a），App 照编照跑，只是没有 shell 工具
//    1 → 真实现，链接 ThirdParty/ish/libish.a
//
//  这么设计是因为 iSH 的静态库很大（几十 MB），且需要 iOS 真机验证；
//  让「没有它的构建」也能过 CI，比让整个工程编不过要好得多。
//

#include <errno.h>
#include <stdlib.h>
#include <string.h>

#if COOMI_HAS_ISH

// ============ 真实现 ============

#include "ishembed.h"

int ish_available(void) {
    return 1;
}

/// 起内核。`rootfs` 是宿主侧 fakefs 根目录（里面会有 data/ 和 meta.db）。
///
/// 返回 0 成功，否则是 `ish_embed_status_t` 的负值。
int coomi_ish_boot(const char *rootfs, const char *workdir, void **out_instance) {
    if (rootfs == NULL || out_instance == NULL) {
        return ISH_ERR_INVALID_ARG;
    }

    ish_embed_boot_opts_t opts;
    memset(&opts, 0, sizeof(opts));
    opts.rootfs_path = rootfs;
    opts.workdir = (workdir != NULL) ? workdir : "/";
    opts.supervisor_guest_path = NULL;   // 用默认 /sbin/ishsv
    opts.kernel_log_fd = -1;             // printk 走 stderr（Console.app 可见）
    opts.reserved_flags = 0;

    ish_embed_instance_t *inst = NULL;
    int rc = ish_embed_boot(&opts, &inst);
    if (rc != ISH_OK) {
        return rc;
    }
    *out_instance = (void *) inst;
    return 0;
}

/// 跑一条命令并拿回 stdout/stderr/退出码（同步）。
///
/// `argv` 是 NULL 结尾的 C 字符串数组。
/// `out_*` 由调用方 free（或用 coomi_ish_free）。
int coomi_ish_run(void *instance,
                  const char *const *argv,
                  const char *cwd,
                  unsigned int timeout_ms,
                  int *out_exit_code,
                  int *out_signal,
                  int *out_timed_out,
                  char **out_stdout,
                  size_t *out_stdout_len,
                  char **out_stderr,
                  size_t *out_stderr_len) {
    if (instance == NULL || argv == NULL) {
        return ISH_ERR_INVALID_ARG;
    }

    ish_embed_spawn_opts_t opts;
    memset(&opts, 0, sizeof(opts));
    opts.argv = argv;
    opts.cwd = cwd;
    opts.envp = NULL;                  // 用 supervisor 的默认环境
    opts.allocate_tty = 0;             // 管道模式，不需要 TTY
    opts.merge_stderr_into_stdout = 0; // stdout/stderr 分开收
    opts.timeout_ms = timeout_ms;
    opts.chroot_path = NULL;
    opts.reserved_flags = 0;

    ish_embed_oneshot_result_t result;
    memset(&result, 0, sizeof(result));

    int rc = ish_embed_run_oneshot((ish_embed_instance_t *) instance, &opts, &result);
    if (rc != ISH_OK) {
        return rc;
    }

    if (out_exit_code != NULL) *out_exit_code = result.exit_code;
    if (out_signal != NULL) *out_signal = result.signal;
    if (out_timed_out != NULL) *out_timed_out = result.timed_out;

    // 把 malloc 出来的缓冲直接交给调用方（零拷贝），
    // 调用方用 coomi_ish_free 释放。
    if (out_stdout != NULL) {
        *out_stdout = (char *) result.stdout_buf;
    } else {
        ish_embed_free(result.stdout_buf);
    }
    if (out_stdout_len != NULL) *out_stdout_len = result.stdout_len;

    if (out_stderr != NULL) {
        *out_stderr = (char *) result.stderr_buf;
    } else {
        ish_embed_free(result.stderr_buf);
    }
    if (out_stderr_len != NULL) *out_stderr_len = result.stderr_len;

    return 0;
}

void coomi_ish_free(void *p) {
    ish_embed_free(p);
}

int coomi_ish_shutdown(void *instance, unsigned int grace_ms) {
    if (instance == NULL) {
        return ISH_ERR_INVALID_ARG;
    }
    return ish_embed_shutdown((ish_embed_instance_t *) instance, grace_ms);
}

#else  // !COOMI_HAS_ISH

// ============ 桩实现 ============
//
// 工程没链接 libish.a 时用这套：App 能编、能跑 UI、引擎照常工作，
// 只是「AI 执行 shell 命令」不可用。Readiness 会把它标成「可选·缺失」。
//
// 错误码与 `ishembed.h` 的 `ish_embed_status_t` 数值一致，
// 这样 Swift 侧不需要区分「真实现 / 桩」两套码。

#define ISH_ERR_BOOT        (-1)
#define ISH_ERR_NOT_RUNNING (-9)

int ish_available(void) {
    return 0;
}

int coomi_ish_boot(const char *rootfs, const char *workdir, void **out_instance) {
    (void) rootfs;
    (void) workdir;
    (void) out_instance;
    return ISH_ERR_BOOT;
}

int coomi_ish_run(void *instance,
                  const char *const *argv,
                  const char *cwd,
                  unsigned int timeout_ms,
                  int *out_exit_code,
                  int *out_signal,
                  int *out_timed_out,
                  char **out_stdout,
                  size_t *out_stdout_len,
                  char **out_stderr,
                  size_t *out_stderr_len) {
    (void) instance;
    (void) argv;
    (void) cwd;
    (void) timeout_ms;
    (void) out_exit_code;
    (void) out_signal;
    (void) out_timed_out;
    (void) out_stdout;
    (void) out_stdout_len;
    (void) out_stderr;
    (void) out_stderr_len;
    return ISH_ERR_NOT_RUNNING;
}

void coomi_ish_free(void *p) {
    (void) p;
}

int coomi_ish_shutdown(void *instance, unsigned int grace_ms) {
    (void) instance;
    (void) grace_ms;
    return ISH_ERR_NOT_RUNNING;
}

#endif  // COOMI_HAS_ISH
