# 扩展模板

1. 复制本文件夹为 `../yourapp.cdn`
2. 修改 `manifest.yaml` 里的 `id`、`process_names`、`url_include_regex`
3. 主面板 → 扩展 → **重新加载**
4. 需要扫缓存/拼 URL 时再写 `plugin.py` 的 `collect_candidates`
