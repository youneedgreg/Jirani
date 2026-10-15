# AWS integration (AWS Builder mini challenge)

Status: planned for Days 1 to 4. Today the whole stack runs locally (`pnpm demo`);
the runtime boundaries below were designed so each piece moves to AWS without
changing the core logic.

| Piece | Local today | AWS target | Code boundary |
| --- | --- | --- | --- |
| Ring webhook | Express route `/ring/webhook` | Lambda + Function URL | `services/webhook/src/handler.ts` (framework-agnostic) |
| MCP server | Express route `/mcp`, stateless | Lambda + Function URL (stateless Streamable HTTP) | `services/mcp/src/tools.ts` |
| State | `MemoryStore` (+ JSON file) | DynamoDB single table | `Store` interface in `services/mcp/src/store.ts` |
| Ladder timers | `setInterval` every 60 s | EventBridge Scheduler: one-off schedule per escalation step + nightly/weekly jobs | `runEvaluation()` in `services/mcp/src/runtime.ts` |
| Agent | (Day 3) | Strands Agents TS SDK on Amazon Bedrock, calling this MCP server via `McpClient` | `packages/agent` |
| Messages | Outbox printed to console | Amazon SES (sandbox, verified addresses) | `Store.deliver()` |
| Infra | n/a | AWS CDK (TypeScript) in `infra/` | `cdk deploy` / `cdk destroy` |

DynamoDB keys (single table): `PK = HOUSE#<id>`; `SK` = `EVENT#<ts>`, `REQ#<requestId>`
(idempotency, TTL 7 days), `CTX#<id>`, `ESC#<id>`, `REPORT#<isoWeek>`.

Cost guard: AWS Budgets alert at $10; `cdk destroy` when not in use.
