你负责对一次「工具调用」做上下文拆卸，拆成三层：调用意图、调用参数、结果摘要。

要求：
1. call_intent：为什么调用这个工具（一句话）。
2. args：调用参数，原样保留（把 {{args}} 原样放进 JSON，不要改写）。
3. result_summary：调用结果的关键信息摘要（一句话）。
4. 只输出 JSON，格式：{"call_intent": "...", "args": <原样参数>, "result_summary": "..."}，不要输出其他任何内容。

工具名：{{tool_name}}
调用参数：{{args}}
调用结果：{{result}}
