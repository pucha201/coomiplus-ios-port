//! 行级统一 diff：给「本轮改了哪些文件」的展开视图用。
//!
//! 只在引擎里做一次，前端只负责按行上色。两个约束：
//! - 有界：单文件超过 `MAX_LINES` 行或结果超过 `MAX_BYTES` 字节就退化成
//!   「整段删除 + 整段新增」，绝不把几十 MB 的文本塞进事件里；
//! - 不猜：拿不到修改前内容（例如 shell 里改的文件）就返回空字符串，
//!   前端只显示行数统计，不伪造 diff。

/// 单文件参与对比的最大行数。超过就退化成整段替换。
const MAX_LINES: usize = 1200;
/// 单个文件 diff 文本的上限。
pub const MAX_BYTES: usize = 64 * 1024;
/// hunk 前后保留的上下文行数。
const CONTEXT: usize = 3;

/// 生成 `--- a/path` / `+++ b/path` + 带上下文的 hunk。
///
/// `before` 为 None 表示新文件（全部算新增）。
pub fn unified_diff(path: &str, before: Option<&str>, after: &str) -> String {
    let old: Vec<&str> = before.unwrap_or("").lines().collect();
    let new: Vec<&str> = after.lines().collect();
    let mut out = String::with_capacity(1024);
    out.push_str(&format!("--- a/{path}\n+++ b/{path}\n"));

    if old.len() > MAX_LINES || new.len() > MAX_LINES {
        out.push_str(&format!("@@ -1,{} +1,{} @@\n", old.len(), new.len()));
        for line in &old {
            out.push('-');
            out.push_str(line);
            out.push('\n');
        }
        for line in &new {
            out.push('+');
            out.push_str(line);
            out.push('\n');
        }
        return truncate(out);
    }

    // LCS 动态规划：1200×1200 的 u32 表 = 5.7MB，桌面/手机都可接受，
    // 且只在文件真的被写时才跑一次。
    let rows = old.len();
    let cols = new.len();
    let mut dp = vec![vec![0u32; cols + 1]; rows + 1];
    for i in (0..rows).rev() {
        for j in (0..cols).rev() {
            dp[i][j] = if old[i] == new[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }

    // 先摊平成完整操作序列，再按上下文分 hunk。
    let mut ops: Vec<(char, &str)> = Vec::with_capacity(rows + cols);
    let (mut i, mut j) = (0usize, 0usize);
    while i < rows && j < cols {
        if old[i] == new[j] {
            ops.push((' ', old[i]));
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            ops.push(('-', old[i]));
            i += 1;
        } else {
            ops.push(('+', new[j]));
            j += 1;
        }
    }
    while i < rows {
        ops.push(('-', old[i]));
        i += 1;
    }
    while j < cols {
        ops.push(('+', new[j]));
        j += 1;
    }

    // 标记需要输出的行：所有变更行 + 前后 CONTEXT 行。
    let mut keep = vec![false; ops.len()];
    for (index, (kind, _)) in ops.iter().enumerate() {
        if *kind == ' ' {
            continue;
        }
        let from = index.saturating_sub(CONTEXT);
        let to = (index + CONTEXT + 1).min(ops.len());
        for slot in keep.iter_mut().take(to).skip(from) {
            *slot = true;
        }
    }
    if !keep.iter().any(|value| *value) {
        return String::new();
    }

    // 逐行推进旧/新行号，遇到断档就开新 hunk。
    let mut old_line = 1usize;
    let mut new_line = 1usize;
    let mut index = 0usize;
    while index < ops.len() {
        if !keep[index] {
            if ops[index].0 != '+' {
                old_line += 1;
            }
            if ops[index].0 != '-' {
                new_line += 1;
            }
            index += 1;
            continue;
        }
        let start_old = old_line;
        let start_new = new_line;
        let mut body = String::new();
        let mut old_count = 0usize;
        let mut new_count = 0usize;
        while index < ops.len() && keep[index] {
            let (kind, text) = ops[index];
            body.push(kind);
            body.push_str(text);
            body.push('\n');
            if kind != '+' {
                old_line += 1;
                old_count += 1;
            }
            if kind != '-' {
                new_line += 1;
                new_count += 1;
            }
            index += 1;
        }
        out.push_str(&format!(
            "@@ -{start_old},{old_count} +{start_new},{new_count} @@\n"
        ));
        out.push_str(&body);
    }
    truncate(out)
}

fn truncate(mut text: String) -> String {
    if text.len() <= MAX_BYTES {
        return text;
    }
    let mut cut = MAX_BYTES;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text.truncate(cut);
    text.push_str("\n…（差异过长，已截断）\n");
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_file_is_all_added() {
        let diff = unified_diff("a.txt", None, "one\ntwo\n");
        assert!(diff.contains("+one"));
        assert!(diff.contains("+two"));
        assert!(!diff.contains("-one"));
    }

    #[test]
    fn unchanged_file_produces_no_diff() {
        // 内容没变就不产出 diff：前端据此显示「+0 −0」，也不会多一个空的展开箭头。
        assert!(unified_diff("a.txt", Some("same\n"), "same\n").is_empty());
    }

    #[test]
    fn single_line_change_keeps_context() {
        let before = "a\nb\nc\nd\ne\n";
        let after = "a\nb\nX\nd\ne\n";
        let diff = unified_diff("a.txt", Some(before), after);
        assert!(diff.contains("-c"));
        assert!(diff.contains("+X"));
        assert!(diff.contains(" b")); // 上下文行
    }
}
