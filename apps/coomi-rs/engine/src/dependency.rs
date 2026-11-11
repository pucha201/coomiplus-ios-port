//! 工具执行依赖图 —— 分析工具调用之间的依赖关系，实现并行执行。
//!
//! 当 Agent 同时计划多个工具调用时，分析它们之间的数据依赖，
//! 构建 DAG 并按拓扑排序分层，无依赖的工具可以并行执行。

use crate::ToolCall;
use std::collections::{HashMap, HashSet, VecDeque};

/// 工具依赖图
pub struct ToolDependencyGraph {
    nodes: HashMap<String, ToolCall>,
    edges: HashMap<String, Vec<String>>, // node -> [dependencies]
}

impl ToolDependencyGraph {
    /// 从工具调用列表构建依赖图
    pub fn build(calls: &[ToolCall]) -> Self {
        let mut nodes = HashMap::new();
        let mut edges: HashMap<String, Vec<String>> = HashMap::new();

        for call in calls {
            nodes.insert(call.id.clone(), call.clone());
            edges.insert(call.id.clone(), Vec::new());
        }

        // 分析依赖关系：如果 call A 的 arguments 中引用了 call B 的 id，则 A 依赖 B
        for (i, call_a) in calls.iter().enumerate() {
            let args_str = call_a.arguments.to_string();
            for (j, call_b) in calls.iter().enumerate() {
                if i == j {
                    continue;
                }
                if args_str.contains(&call_b.id) {
                    edges
                        .entry(call_a.id.clone())
                        .or_default()
                        .push(call_b.id.clone());
                }
            }
        }

        Self { nodes, edges }
    }

    /// 获取节点的所有依赖
    pub fn dependencies(&self, node: &str) -> Vec<&str> {
        self.edges
            .get(node)
            .map(|deps| deps.iter().map(|d| d.as_str()).collect())
            .unwrap_or_default()
    }

    /// 获取依赖此节点的节点
    pub fn dependents(&self, node: &str) -> Vec<&str> {
        let mut result = Vec::new();
        for (n, deps) in &self.edges {
            if deps.contains(&node.to_string()) {
                result.push(n.as_str());
            }
        }
        result
    }

    /// 检测循环依赖
    pub fn has_cycle(&self) -> bool {
        let mut visited = HashSet::new();
        let mut in_stack = HashSet::new();

        for node in self.nodes.keys() {
            if !visited.contains(node) {
                if self.dfs(node, &mut visited, &mut in_stack) {
                    return true;
                }
            }
        }
        false
    }

    fn dfs(
        &self,
        node: &str,
        visited: &mut HashSet<String>,
        in_stack: &mut HashSet<String>,
    ) -> bool {
        visited.insert(node.to_string());
        in_stack.insert(node.to_string());

        if let Some(deps) = self.edges.get(node) {
            for dep in deps {
                if !visited.contains(dep) {
                    if self.dfs(dep, visited, in_stack) {
                        return true;
                    }
                } else if in_stack.contains(dep) {
                    return true;
                }
            }
        }

        in_stack.remove(node);
        false
    }

    /// 拓扑排序（Kahn 算法）
    pub fn topological_sort(&self) -> Option<Vec<String>> {
        if self.has_cycle() {
            return None;
        }

        let mut in_degree: HashMap<String, usize> =
            self.nodes.keys().map(|k| (k.clone(), 0)).collect();

        for (node, deps) in &self.edges {
            in_degree.insert(node.clone(), deps.len());
        }

        let mut queue: VecDeque<String> = in_degree
            .iter()
            .filter(|&(_, deg)| *deg == 0)
            .map(|(k, _)| k.clone())
            .collect();

        let mut result = Vec::new();

        while let Some(node) = queue.pop_front() {
            result.push(node.clone());
            {
                for dep in self.dependents(&node) {
                    if let Some(deg) = in_degree.get_mut(dep) {
                        *deg -= 1;
                        if *deg == 0 {
                            queue.push_back(dep.to_owned());
                        }
                    }
                }
            }
        }

        if result.len() == self.nodes.len() {
            Some(result)
        } else {
            None
        }
    }

    /// 返回可并行执行的层级（拓扑分层）
    pub fn execution_layers(&self) -> Vec<Vec<String>> {
        let mut in_degree: HashMap<String, usize> =
            self.nodes.keys().map(|k| (k.clone(), 0)).collect();

        for (node, deps) in &self.edges {
            in_degree.insert(node.clone(), deps.len());
        }

        let mut layers = Vec::new();
        let mut current: Vec<String> = in_degree
            .iter()
            .filter(|&(_, deg)| *deg == 0)
            .map(|(k, _)| k.clone())
            .collect();

        while !current.is_empty() {
            layers.push(current.clone());
            let to_remove = current.clone();
            current = Vec::new();

            for node in &to_remove {
                {
                    for dep in self.dependents(node) {
                        if let Some(deg) = in_degree.get_mut(dep) {
                            *deg -= 1;
                            if *deg == 0 {
                                current.push(dep.to_owned());
                            }
                        }
                    }
                }
            }
        }

        layers
    }

    /// 获取无依赖的根节点
    pub fn roots(&self) -> Vec<&str> {
        self.edges
            .iter()
            .filter(|(_, deps)| deps.is_empty())
            .map(|(n, _)| n.as_str())
            .collect()
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_graph_no_deps() {
        let calls = vec![
            ToolCall {
                id: "1".into(),
                name: "read".into(),
                arguments: serde_json::json!({}),
            },
            ToolCall {
                id: "2".into(),
                name: "write".into(),
                arguments: serde_json::json!({}),
            },
        ];
        let graph = ToolDependencyGraph::build(&calls);
        assert_eq!(graph.len(), 2);
        assert!(!graph.has_cycle());
        assert_eq!(graph.roots().len(), 2);
    }

    #[test]
    fn test_execution_layers() {
        let calls = vec![
            ToolCall {
                id: "a".into(),
                name: "read".into(),
                arguments: serde_json::json!({}),
            },
            ToolCall {
                id: "b".into(),
                name: "grep".into(),
                arguments: serde_json::json!({"pattern": "use a"}),
            },
            ToolCall {
                id: "c".into(),
                name: "write".into(),
                arguments: serde_json::json!({"content": "use b"}),
            },
        ];
        let graph = ToolDependencyGraph::build(&calls);
        let layers = graph.execution_layers();
        assert_eq!(layers.len(), 3);
        assert_eq!(layers[0], vec!["a"]);
        assert_eq!(layers[1], vec!["b"]);
        assert_eq!(layers[2], vec!["c"]);
    }
}
