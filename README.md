# 🚀 Revolution — Multi-Agent Auto-Evolution

**Let your AI agents build things while you sleep.**

Revolution orchestrates multiple AI agents in an autonomous review → execute → audit loop. You define a goal, break it into subtasks, and the system iterates through them automatically — with built-in quality gates and self-healing.

## How It Works

```
You define a task
    ↓
Reviewer agent audits the plan & generates instructions
    ↓
Executor agent implements one subtask
    ↓
Auditor verifies the result
    ↓
Repeat until all subtasks complete ✅
    ↓
Auto-packaged as a skill
```

Each role can use a different model — expensive models for review/audit, cheap models for execution. Pay for intelligence where it matters.

## Requirements

- [OpenClaw](https://github.com/openclaw/openclaw) with cron support
- At least 2 configured agents (coordinator + executor)
- Models that support `sessions_spawn`

## Quick Start

### 1. Install

```bash
clawhub install auto-evolution
```

Or clone manually:
```bash
git clone https://github.com/anthropic-lab/revolution-skill.git
cp -r revolution-skill ~/.openclaw/workspace/skills/auto-evolution
```

### 2. Initialize

```bash
cd ~/.openclaw/workspace
mkdir -p evolution/tasks evolution/archive evolution/test-results
```

### 3. Create a Task

```bash
cp skills/auto-evolution/references/task-example.json evolution/tasks/task-001.json
# Edit task-001.json with your actual goal and subtasks
```

### 4. Configure Heartbeats

```bash
# Coordinator (scans pending → spawns reviewer)
openclaw cron add --agent wilson \
  --name "evo-coordinator" --every 5m \
  --model "your-model" --session isolated \
  --timeout-seconds 300 \
  --message "Evolution heartbeat: scan pending tasks, spawn reviewer."

# Executor (picks up reviewed → executes)
openclaw cron add --agent iron \
  --name "evo-executor" --every 5m \
  --model "your-model" --session isolated \
  --timeout-seconds 600 \
  --message "Evolution heartbeat: execute next reviewed subtask."

# Monitor (detects stuck tasks → auto-fixes)
openclaw cron add --agent warden \
  --name "evo-monitor" --every 10m \
  --model "your-model" --session isolated \
  --timeout-seconds 120 \
  --message "Evolution monitor: detect stuck tasks, clean locks."
```

### 5. Watch It Run

```bash
# Check task status
ls evolution/tasks/*.json | xargs -I{} sh -c 'echo "$(basename {}): $(python3 -c "import json;d=json.load(open(\"{}\")); print(d[\"status\"],\"iter\",d[\"current_iteration\"])")"'
```

## Architecture

| Role | What It Does | Recommended Model |
|------|-------------|-------------------|
| **Designer** | Initial task breakdown | Opus / o3 / DeepSeek R1 |
| **Reviewer** | Audit plan, generate instructions | Sonnet / GPT-4o |
| **Executor** | Write code, run tests | Qwen / Haiku / Gemini Flash |
| **Auditor** | Verify results | Sonnet / GPT-4o |
| **Monitor** | Detect stuck tasks, auto-reset | Qwen / Haiku |

Models are **fully swappable**. The system is model-agnostic — it only cares about the role protocol.

## State Machine

```
pending → reviewing → reviewed → executing → pending (loop)
                                            → completed
                                            → packaged ✅
```

- One subtask per iteration (keeps each cycle fast)
- Monitor auto-resets tasks stuck > 10 minutes
- Failed reviews trigger retry (up to `max_iterations`)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_WORKSPACE` | `~/.openclaw/agents/main/workspace` | Workspace root |
| `EVOLUTION_TASKS_DIR` | `{workspace}/evolution/tasks` | Active tasks |
| `EVOLUTION_SKILLS_DIR` | `{workspace}/skills` | Output skills |
| `EVOLUTION_ARCHIVE_DIR` | `{workspace}/evolution/archive` | Completed tasks |

## File Structure

```
auto-evolution/           ← This skill
├── SKILL.md
├── README.md
├── config/
│   └── task-schema.json
├── scripts/
│   ├── heartbeat-wilson.js   (coordinator)
│   ├── heartbeat-iron.js     (executor)
│   ├── heartbeat-warden.js   (monitor)
│   └── pack-skill.js         (packager)
└── references/
    └── task-example.json

evolution/                ← Runtime data (in your workspace)
├── tasks/
│   └── task-001.json
├── archive/
└── test-results/
```

## Design Principles

- **One subtask per iteration** — predictable, reviewable, won't timeout
- **No quality shortcuts** — reviewer API down? Wait and retry. Never skip review.
- **Cost-efficient** — expensive models only where judgment matters
- **Self-healing** — monitor detects and fixes stuck states
- **Composable** — swap models, agents, or prompts without changing the protocol

## License

MIT

---

Built with [OpenClaw](https://openclaw.ai) 🐾
