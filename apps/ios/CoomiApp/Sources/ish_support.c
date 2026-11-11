//
//  ish_support.c
//  Coomi 的 iSH 桥接层（C 侧实现）
//
//  作用：把 iSH 内核的内部 API 包装成 5 个可从 Swift 调用的函数。
//
//  ⚠️ 本文件的每个调用都已对照 **iSH master 的真实源码** 核对（不只是头文件存在性）：
//
//    xX_main_Xx.h:48-89   getopt "-r <root>" → mount_root(fs, root_realpath)
//                         → become_first_process() → current->thread = pthread_self()
//    main.c:9-23          完整序列：xX_main_Xx → create_some_device_nodes
//                         → do_mount(procfs) → do_mount(devptsfs) → task_run_current
//    app/TerminalViewController.m:194-198  do_execve(...) → task_start(current)
//    kernel/task.c:43     task_create_ 里 `*task = *parent`（fork 语义，会共享 mm）
//    kernel/signal.h      send_signal(task, sig, siginfo_)，SIGINFO_NIL 是 static const
//
//  前期版本凭"想当然"写错了三处，均已修正：
//    ① 自己调 task_create_ 建任务 —— iSH 起 shell 根本不建，直接在当前 task 上 exec；
//    ② 以为要自己 mount_root —— 其实是 xX_main_Xx 用 `-r` 参数内部做的；
//    ③ 漏了 become_first_process / current->thread 初始化 —— 缺了它调度起不来。
//

#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#if COOMI_HAS_ISH

#include "kernel/calls.h"
#include "kernel/fs.h"
#include "kernel/init.h"
#include "kernel/signal.h"
#include "kernel/task.h"
#include "fs/devices.h"
#include "fs/real.h"
#include "xX_main_Xx.h"

/// 当前 App 的 Linux 根在宿主上的绝对路径。
/// 必须在调用 ish_boot **之前**通过 ish_set_root 设置好。
static char g_root[PATH_MAX];

int ish_available(void) {
    return 1;
}

int ish_set_root(const char *path) {
    if (path == NULL || path[0] == '\0') {
        return EINVAL;
    }
    size_t len = strlen(path);
    if (len >= sizeof(g_root)) {
        return ENAMETOOLONG;
    }
    memcpy(g_root, path, len + 1);
    return 0;
}

int ish_boot(void) {
    if (g_root[0] == '\0') {
        // 没设根就启动 = 把宿主 `/` 当 Linux 根，会在 iOS 上到处报权限错。
        return EINVAL;
    }

    // 复刻 iSH App 的 main()：
    //   argv 用 getopt 风格传入 `-r <root>`，让 xX_main_Xx 自己 mount_root。
    //   不能自己调 mount_root —— 那样会漏掉 become_first_process() 与
    //   current->thread 的初始化，调度器起不来。
    char arg0[] = "coomi";
    char argR[] = "-r";
    char rootBuf[PATH_MAX];
    memcpy(rootBuf, g_root, strlen(g_root) + 1);
    char *argv[] = {arg0, argR, rootBuf, NULL};
    char env[] = "TERM=xterm-256color\0";

    int err = xX_main_Xx(3, argv, env);
    if (err < 0) {
        return -err;
    }

    // 与 main.c 一致的后续步骤：建设备节点，挂 /proc 与 /dev/pts。
    // 缺 /proc 会让大量程序行为异常（Rust std 也读它）。
    create_some_device_nodes();

    err = do_mount(&procfs, "proc", "/proc", "", 0);
    if (err < 0) {
        return -err;
    }
    err = do_mount(&devptsfs, "devpts", "/dev/pts", "", 0);
    if (err < 0) {
        return -err;
    }
    return 0;
}

int ish_mount_pseudo_filesystems(void) {
    // 已在 ish_boot 里完成；保留此入口是为了让 Swift 侧的调用顺序稳定。
    int err = do_mount(&procfs, "proc", "/proc", "", 0);
    if (err < 0) {
        return -err;
    }
    err = do_mount(&devptsfs, "devpts", "/dev/pts", "", 0);
    if (err < 0) {
        return -err;
    }
    return 0;
}

void *ish_spawn_shell(const char *command, int *error_out) {
    if (error_out != NULL) {
        *error_out = 0;
    }
    if (command == NULL) {
        if (error_out != NULL) {
            *error_out = EINVAL;
        }
        return NULL;
    }

    // 照 iSH App 起 shell 的两步走（app/TerminalViewController.m:194-198）：
    //     do_execve(cmd, argc, argv, envp);
    //     task_start(current);
    //
    // **不要** task_create_：它的第一行是 `*task = *parent`，会把父任务的
    // mm/mem 指针一并复制，两个 task 共享同一地址空间，同时跑就会互相踩。
    // App 进程本身就是一个 Linux 进程，直接在当前 task 上 exec 即可。
    char *const argv[] = {"sh", "-c", (char *) command, NULL};
    char *const envp[] = {
        "TERM=xterm-256color",
        "HOME=/root",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        NULL,
    };
    int err = do_execve("/bin/sh", 3, (const char *) argv, (const char *) envp);
    if (err < 0) {
        if (error_out != NULL) {
            *error_out = -err;
        }
        return NULL;
    }

    task_start(current);
    return (void *) current;
}

void ish_kill_task(void *task_ptr, int signal_number) {
    struct task *task = (struct task *) task_ptr;
    if (task == NULL) {
        return;
    }
    // 真实签名：void send_signal(struct task *task, int sig, struct siginfo_ info)
    send_signal(task, signal_number, SIGINFO_NIL);
}

#else  // !COOMI_HAS_ISH

// 未链接 iSH 时的桩：工程照样能编、能跑 UI，只是引擎起不来
//（界面会给出「未链接 iSH 运行时」的明确提示，而不是崩溃）。

int ish_available(void) { return 0; }
int ish_set_root(const char *path) { (void) path; return ENOSYS; }
int ish_boot(void) { return ENOSYS; }
int ish_mount_pseudo_filesystems(void) { return ENOSYS; }
void *ish_spawn_shell(const char *command, int *error_out) {
    (void) command;
    if (error_out != NULL) {
        *error_out = ENOSYS;
    }
    return NULL;
}
void ish_kill_task(void *task, int sig) { (void) task; (void) sig; }

#endif
