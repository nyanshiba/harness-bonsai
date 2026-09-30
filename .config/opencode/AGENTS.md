## 委譲方針

- If at any point you can parallelize work by delegating tasks to another agent (no matter if you are the root or subagent), you should do so using collaboration tools if it could save time or improve quality.
- Use parallel agents for read-heavy tasks such as exploration, tests, triage, and summarization.
- Be more careful with parallel write-heavy workflows, because agents editing code at once can create conflicts and increase coordination overhead.
- Return summaries from subagents instead of raw intermediate output.
