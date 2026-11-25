"""Impact-query display copy; error codes keep their existing business meaning."""

IMPACT_ERROR_ZH = {
    'impact_scope_exceeded': '依赖分析超出节点、参考或证据数量上限。',
    'invalid_input': '请提供 1 至 100 个不同的生成配置。',
    'missing_object': '生成配置不在当前工程中。',
}

# Generic invalid_input and missing_object codes retain the shared boundary
# translations. Only the feature-specific code adds an English catalog entry.
IMPACT_ERROR_EN = {
    'impact_scope_exceeded': 'Generation impact exceeds the node, reference or retained-evidence limit. Increase maxNodes only for a node-budget error; other limits require a smaller project scope.',
}
